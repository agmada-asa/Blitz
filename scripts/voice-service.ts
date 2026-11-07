/** Loopback-only microphone service: streamed PCM, local turn detection, Whisper, and private turn logs. */
import { createServer } from "node:http"
import { spawn, execFileSync } from "node:child_process"
import { createInterface } from "node:readline"
import { mkdir, access, writeFile, rename, appendFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { WebSocketServer, WebSocket } from "ws"
import { VoiceTurns } from "./voice-turns.ts"

const appPort = Number(process.env.BLITZ_PORT ?? 3007)
const port = Number(process.env.BLITZ_VOICE_PORT ?? appPort + 100)
const appOrigin = `http://127.0.0.1:${process.env.BLITZ_PORT ?? 3007}`
const directory = join(homedir(), "Library", "Application Support", "Blitz", "voice")
const python = process.env.BLITZ_KOKORO_PYTHON || join(process.env.BLITZ_KOKORO_DIR || join(homedir(), "Library", "Application Support", "Blitz", "kokoro"), "venv", "bin", "python3")
const origins = new Set((process.env.BLITZ_VOICE_ORIGINS || `http://localhost:${appPort},http://127.0.0.1:${appPort}`).split(",").map(x => x.trim()))
try {
  const status = JSON.parse(execFileSync("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }))
  const host = status.Self?.DNSName?.replace(/\.$/, "")
  if (host) origins.add(`https://${host}:${process.env.BLITZ_VOICE_HTTPS_PORT || 8443}`)
} catch { /* Optional tailnet access; localhost works without this CLI. */ }
const server = createServer((_request, response) => { response.writeHead(200); response.end("ready") })
const sockets = new WebSocketServer({ noServer: true, maxPayload: 32000 })
server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/voice" || !origins.has(request.headers.origin || "") || sockets.clients.size >= 2) {
    socket.destroy()
    return
  }
  sockets.handleUpgrade(request, socket, head, ws => sockets.emit("connection", ws, request))
})
let models: Promise<void> | undefined

/** Atomically downloads the two public ONNX models once per service lifetime. */
async function ensureModels(): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (const [name, url] of [
    ["silero_vad.onnx", "https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx"],
    ["smart-turn-v3.2-cpu.onnx", "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx"],
  ]) {
    const path = join(directory, name)
    try { await access(path); continue } catch {}
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) })
    if (!response.ok) throw new Error("Turn detection models could not be downloaded. Try again.")
    await writeFile(path + ".download", Buffer.from(await response.arrayBuffer()), { mode: 0o600 })
    await rename(path + ".download", path)
  }
}

/** Encodes streamed PCM16 as a mono 16 kHz WAV for the existing transcription route. */
function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44)
  header.write("RIFF"); header.writeUInt32LE(pcm.length + 36, 4); header.write("WAVEfmt ", 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

let logging = Promise.resolve()
/** Serializes bounded private logs, including the words explicitly requested by the owner. */
function log(value: object): void {
  logging = logging.then(async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, "turns.jsonl")
    if (((await stat(path).catch(() => null))?.size ?? 0) > 10 * 1024 * 1024) {
      await rename(path, path + ".previous")
    }
    await appendFile(path, JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n", { mode: 0o600 })
  }).catch(error => console.error("Voice log failed", error))
}

sockets.on("connection", socket => {
  let worker: ReturnType<typeof spawn> | undefined
  let started = false
  let prompt = ""
  let closed = false
  let bargeTimer: ReturnType<typeof setTimeout> | undefined
  const lifetime = new AbortController()
  const limit = setTimeout(() => socket.close(1000, "Session limit reached. Reconnect."), 30 * 60_000)

  /** Sends one protocol message only while the owning connection is live. */
  function send(value: object): void { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)) }
  /** Reports recoverable errors and closes the microphone connection. */
  function fail(error: unknown): void {
    send({ type: "error", message: error instanceof Error ? error.message : "Voice failed. Reconnect." })
    socket.close()
  }
  /** Transcribes a snapshot without saving raw audio beyond the request. */
  async function transcribe(pcm: Buffer): Promise<string> {
    const response = await fetch(appOrigin + "/api/audio/transcribe", {
      method: "POST", body: new Uint8Array(wav(pcm)), signal: lifetime.signal,
      headers: { "x-voice-vocabulary": encodeURIComponent(prompt) },
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || "Transcription failed.")
    return result.text
  }
  // Muting resets the turn, so a transcript still in flight is dropped rather than sent later.
  const turns = new VoiceTurns({
    transcribe, send, log, fail,
    endTurn: () => worker?.stdin?.write('{"end":true}\n'),
    closed: () => closed,
  })
  socket.on("message", (data, binary) => {
    if (binary) {
      if (!started || turns.transcribing) return
      const frame = Buffer.from(data as Buffer)
      if (!turns.audio(frame)) return
      if (turns.mode !== "dictate") worker?.stdin?.write(JSON.stringify({ pcm: frame.toString("base64") }) + "\n")
      return
    }
    try {
      const message = JSON.parse(data.toString())
      if (message.type === "reset") { clearTimeout(bargeTimer); turns.reset() }
      if (message.type === "start" && !started) {
        started = true
        const mode = turns.mode = message.mode === "voice" ? "voice" : "dictate"
        prompt = typeof message.prompt === "string" ? message.prompt.slice(-2000) : ""
        void (async () => {
          const warm = await fetch(appOrigin + "/api/audio/transcribe?warm=1", { method: "POST", signal: lifetime.signal })
          if (!warm.ok) throw new Error("Speech is not ready. Run scripts/setup-kokoro.sh and retry.")
          if (mode === "dictate") { send({ type: "ready" }); return }
          await (models ??= ensureModels().catch(error => { models = undefined; throw error }))
          if (closed) return
          worker = spawn(python, [join(process.cwd(), "scripts", "voice-listen-worker.py"), directory], { stdio: ["pipe", "pipe", "pipe"] })
          worker.on("error", fail)
          worker.on("exit", () => { if (!closed) fail(new Error("Listening stopped. Reconnect.")) })
          worker.stderr?.on("data", () => {}) // Consume native diagnostics without leaking recording data.
          const lines = createInterface({ input: worker.stdout! })
          lines.on("line", line => {
            try {
              const event = JSON.parse(line)
              if (event.ready) send({ type: "ready" })
              if (event.event === "speech" || event.event === "resume") {
                turns.speech()
                clearTimeout(bargeTimer)
                bargeTimer = setTimeout(() => send({ type: "interrupt" }), 300)
                send({ type: "state", state: "hearing" })
              }
              if (event.event === "pause") {
                clearTimeout(bargeTimer)
                turns.pause()
              }
              if (event.event === "turn" && (event.p >= 0.5 || event.silence_ms >= 1400)) void turns.take()
              if (event.event === "turn") log({ detectionMs: event.ms, silenceMs: event.silence_ms, mode })
            } catch (error) { fail(error) }
          })
        })().catch(fail)
      }
      if (message.type === "stop" && turns.mode === "dictate") void turns.take()
      if (message.type === "reply" && typeof message.text === "string")
        log({ reply: message.text.slice(0, 24000), mode: turns.mode })
      if (message.type === "timing" && Number.isFinite(message.heardMs) && Number.isFinite(message.synthesisMs))
        log({ heardMs: message.heardMs, synthesisMs: message.synthesisMs, mode: turns.mode })
    } catch { fail(new Error("Invalid voice message.")) }
  })
  socket.on("error", () => socket.close())
  socket.on("close", () => {
    closed = true; clearTimeout(limit); clearTimeout(bargeTimer)
    lifetime.abort(); worker?.kill(); turns.clear()
  })
})
server.listen(port, "127.0.0.1", () => console.log(`Voice service listening on loopback port ${port}`))
/** Closes sockets and children when the supervisor stops the service. */
function shutdown(): void { for (const socket of sockets.clients) socket.close(); server.close(); setTimeout(() => process.exit(), 1000).unref() }
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
