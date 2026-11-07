/** Captures echo-cancelled microphone audio as 16 kHz PCM packets for the local speech service. */
/** Sample rate the host listens at. */
const IN_RATE = 16_000;
/** Samples per packet sent to the host: 32 ms, one Silero chunk. */
const PACKET = 512;

/** AudioWorklet source that passes the mic's Float32 samples to the page in batches. */
const TAP = `registerProcessor("voice-tap", class extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(1024); this.used = 0; }
  process([input]) {
    const samples = input[0];
    if (samples) {
      if (this.used + samples.length > this.buffer.length) {
        this.port.postMessage(this.buffer.slice(0, this.used));
        this.used = 0;
      }
      this.buffer.set(samples, this.used);
      this.used += samples.length;
    }
    return true;
  }
});`;

/** An open mic: stop() lets it go. */
export interface Mic {
  /** Disables microphone tracks so muted audio never leaves the browser. */
  mute(value: boolean): void;
  stop(): void;
}

/**
 * Opens the mic with echo cancellation, noise suppression and gain control, and calls
 * [heard] with each 32 ms packet as 16 kHz 16-bit mono, and [level] with its loudness (0..1).
 */
export async function openMic(heard: (packet: Int16Array) => void, level: (rms: number) => void): Promise<Mic> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const context = new AudioContext();
  const moduleUrl = URL.createObjectURL(new Blob([TAP], { type: "text/javascript" }));
  try {
    await context.audioWorklet.addModule(moduleUrl);
    await context.resume();
  } catch (error) {
    stream.getTracks().forEach(track => track.stop());
    void context.close();
    throw error;
  } finally { URL.revokeObjectURL(moduleUrl); }
  const source = context.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(context, "voice-tap");
  // Silent, but connected all the way, so the browser keeps the tap running.
  const silent = context.createGain();
  silent.gain.value = 0;
  source.connect(tap).connect(silent).connect(context.destination);

  // Each 16 kHz sample is the average of the 44.1 or 48 kHz samples it covers.
  const step = context.sampleRate / IN_RATE;
  let unread = new Float32Array(0);
  let at = 0;
  let packet = new Int16Array(PACKET);
  let filled = 0;
  let energy = 0;
  tap.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
    const input = new Float32Array(unread.length + data.length);
    input.set(unread);
    input.set(data, unread.length);
    while (at + step <= input.length) {
      let sum = 0;
      const from = Math.floor(at);
      const to = Math.max(from + 1, Math.floor(at + step));
      for (let i = from; i < to; i++) sum += input[i];
      const sample = Math.max(-1, Math.min(1, sum / (to - from)));
      energy += sample * sample;
      packet[filled++] = sample * 32767;
      at += step;
      if (filled === PACKET) {
        heard(packet);
        level(Math.sqrt(energy / PACKET));
        packet = new Int16Array(PACKET);
        filled = 0;
        energy = 0;
      }
    }
    const used = Math.floor(at);
    unread = input.slice(used);
    at -= used;
  };
  return {
    /** Disables capture at its source while preserving the connection. */
    mute(value: boolean) { stream.getAudioTracks().forEach(track => { track.enabled = !value; }); },
    /** Releases tracks and the capture context. */
    stop() {
      tap.port.onmessage = null;
      stream.getTracks().forEach((track) => track.stop());
      if (context.state !== "closed") void context.close();
    },
  };
}
