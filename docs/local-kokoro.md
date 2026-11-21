# Local speech

Read aloud, podcasts and audiobooks use [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) on the computer hosting Blitz, on macOS or Linux. Spoken questions use Whisper, on Apple silicon Macs only. Both run as Python workers that Next.js starts on demand. How voice mode and dictation use them is in [voice](voice.md).

## Setup

Run `sh scripts/setup-kokoro.sh` from the repository with Python 3 installed (Debian and Ubuntu first need `sudo apt install python3-venv`). It creates an isolated environment in the speech data directory and installs the pinned packages in `scripts/kokoro-requirements.txt`; on Apple silicon these include `mlx-audio` for Kokoro and `mlx-whisper` for transcription. On macOS with Homebrew it also asks you to install `espeak-ng` (`brew install espeak-ng`) for English phonemes.

The data directory is `~/Library/Application Support/Blitz/kokoro` on macOS, or `~/.local/share/blitz/kokoro` on Linux (under `$XDG_DATA_HOME` when it is set). Set `BLITZ_KOKORO_DIR` to move it, and `BLITZ_KOKORO_PYTHON` to pick the interpreter; by default Blitz uses `venv/bin/python3` inside the data directory.

## Kokoro

On Apple silicon, the worker (`scripts/kokoro-worker.py`) loads `mlx-community/Kokoro-82M-bf16` through MLX, which downloads it into the Hugging Face cache on first use. Elsewhere, or if MLX isn't installed, it uses the ONNX model and voice file, downloaded into the data directory on first use. Server startup warms the worker in the background only when the ONNX files are already there, so an MLX-only install loads on the first speech request instead. The worker runs a tiny inference before it reports ready, and shuts down after ten minutes without inference.

## CPU and worker lifetime

Numerical libraries get a two-thread limit before import. On the ONNX path, inference also uses two threads, sequential operator execution and no thread-pool spinning. These reduce CPU use and power; they are thread limits, not a cap on total CPU usage.

Startup has a three-minute deadline, including any first-use model download. Each inference has a two-minute deadline, beginning after the worker is ready. A timeout or failed request rejects the caller, sends SIGTERM, and escalates to SIGKILL after one second if needed. The speech queue waits for the old process to exit before moving on, preventing overlapping replacement workers. A later request can start a fresh worker; a failed inference is never retried automatically. Idle shutdown does not interrupt an active inference.

Node force-kills owned speech processes on exit. Python also checks its parent every second and exits if the owning server disappears, covering abrupt server termination that bypasses Node exit hooks. After switching Git branches, stop and restart the full `npm run dev` launcher so its servers use the same checkout (the background server runs from its own releases and is unaffected); stopping one supervised server alone causes the launcher to restart it.

The speech route (`POST /api/audio/speech`) accepts up to 12,000 characters per request, and 120 for a preparation request. Audiobook and podcast jobs split their text into short pieces and call `synthesizeKokoroToFile` for each.

## Read aloud latency

Chat and Learn share a browser player and the local speech queue. Read aloud uses an opening of at most 120 characters, another short section, then sections of at most 360 characters. It splits at sentence or word boundaries and preserves Unicode characters. Web Audio schedules adjacent sections on the same clock with at most two decoded sections buffered ahead. The audio context resumes directly from the playback click so delayed synthesis does not lose browser user activation.

Only the visible current lesson or latest completed chat reply prepares an opening automatically, after a 250 ms delay. Hover and keyboard focus prepare older replies on demand. Preparation waits for saved voice settings, sends only the opening to the local host, and never plays audio. One speculative request is active per browser; changing content, leaving a control, or starting playback cancels obsolete preparation. The browser keeps up to 24 recent sections within an 8 MiB limit for ten minutes. Voice changes use separate cache keys and stop existing playback.

The server queue gives active playback priority over audiobook and podcast recording sections, then speculative preparation. Matching text and voice requests share synthesis, and a playback request promotes matching pending preparation. Cancelling one consumer leaves other consumers intact. Cancelling all consumers removes unstarted work; an inference already running finishes and can populate the cache. This avoids killing the shared model or interrupting a recording job. A playback request can therefore still wait for one recording section already in progress.

Generated read aloud WAVs remain in a private disk cache capped at 500 MiB and seven days without access. Cache keys contain hashes of voice and text; the cache does not save source text. Disk eviction runs after generation without delaying the response. Fresh text still needs inference time; near-instant playback depends on its opening being prepared or cached. Full audiobook and podcast playback still begins after script preparation, recording, and final assembly complete.

## Speech to text

`lib/server/speech-to-text.ts` runs `scripts/speech-to-text-worker.py` in the same Python environment. It transcribes with Whisper through `mlx_whisper`, using `mlx-community/whisper-large-v3-turbo` unless `BLITZ_WHISPER_MODEL` names another, and drops segments that look invented from silence. It needs an Apple silicon Mac; elsewhere transcription is refused and the rest of Blitz works as usual.

The voice service sends each finished stretch of speech to `POST /api/audio/transcribe` as 16 kHz mono 16-bit PCM WAV (the format in `lib/speech-wav.ts`), so the server needs no audio decoder. The worker gets a private temporary file that is deleted straight after, even if the caller has gone; a transcription cancelled while queued never writes one. Nothing leaves the computer.

The first use downloads the model, so startup is allowed 20 minutes. Each transcription has 60 seconds, and the worker stays loaded for five idle minutes. macOS asks for microphone access the first time.
