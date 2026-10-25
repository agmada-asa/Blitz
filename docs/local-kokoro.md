# Local Kokoro speech

Blitz runs Kokoro on the local macOS Node.js host. The first speech request downloads the Kokoro ONNX model and voice catalogue into `~/Library/Application Support/Blitz/kokoro`; later requests reuse them. A Python worker keeps the model loaded while speech is in use and shuts down after one minute without inference. The next uncached speech request loads it again. Server startup warms the worker in the background when the Python environment and model assets already exist. Startup does not download missing assets; the first requested synthesis still performs initial setup. The worker completes a tiny inference before announcing readiness.

## CPU and worker lifetime

Local inference uses two ONNX threads, sequential operator execution, and no thread-pool spinning. Numerical libraries also receive a two-thread limit before import. These settings reduce CPU use and power consumption; they are thread limits, not a hard percentage cap on total CPU usage.

Startup has a three-minute deadline, including any first-use model download. Each inference has a two-minute deadline, beginning after the worker is ready. A timeout or failed request rejects the caller, sends SIGTERM, and escalates to SIGKILL after one second if needed. The speech queue waits for the old process to exit before moving on, preventing overlapping replacement workers. A later request can start a fresh worker; a failed inference is never retried automatically. Idle shutdown does not interrupt an active inference.

Node force-kills owned speech processes on exit. Python also checks its parent every second and exits if the owning server disappears, covering abrupt server termination that bypasses Node exit hooks. After switching Git branches, stop and restart the full `dev:lan` launcher so its servers use the same checkout; stopping one supervised server alone causes the launcher to restart it.

Install Python 3.10 through 3.13, then run `scripts/setup-kokoro.sh` from the repository. The script creates an isolated environment under the same application support directory and installs pinned packages from `scripts/kokoro-requirements.txt`. For English phonemization, install `espeak-ng` with Homebrew (`brew install espeak-ng`) if it is not already available.

Set `BLITZ_KOKORO_DIR` to move the model, voice files, and Python environment to another writable directory. Set `BLITZ_KOKORO_PYTHON` to select a Python interpreter explicitly; by default Blitz uses `venv/bin/python3` inside the data directory. The web speech route accepts text up to 12,000 characters per request. Longer audiobook and podcast jobs should split content into short chunks and call `synthesizeKokoroToFile` for each chunk.

## Read aloud latency

Chat and Learn share a browser player and the local speech queue. Read aloud uses an opening of at most 120 characters, another short section, then sections of at most 360 characters. It splits at sentence or word boundaries and preserves Unicode characters. Web Audio schedules adjacent sections on the same clock with at most two decoded sections buffered ahead. The audio context resumes directly from the playback click so delayed synthesis does not lose browser user activation.

Only the visible current lesson or latest completed chat reply prepares an opening automatically, after a 250 ms delay. Hover and keyboard focus prepare older replies on demand. Preparation waits for saved voice settings, sends only the opening to the local host, and never plays audio. One speculative request is active per browser; changing content, leaving a control, or starting playback cancels obsolete preparation. The browser keeps up to 24 recent sections within an 8 MiB limit for ten minutes. Voice changes use separate cache keys and stop existing playback.

The server queue gives active playback priority over audiobook and podcast recording sections, then speculative preparation. Matching text and voice requests share synthesis, and a playback request promotes matching pending preparation. Cancelling one consumer leaves other consumers intact. Cancelling all consumers removes unstarted work; an inference already running finishes and can populate the cache. This avoids killing the shared model or interrupting a recording job. A playback request can therefore still wait for one recording section already in progress.

Generated read aloud WAVs remain in a private disk cache capped at 500 MiB and seven days without access. Cache keys contain hashes of voice and text; the cache does not save source text. Disk eviction runs after generation without delaying the response. Fresh text still needs inference time; near-instant playback depends on its opening being prepared or cached. Full audiobook and podcast playback still begins after script preparation, recording, and final assembly complete.

## Voice Teach

The Teach header's **Read replies aloud** switch reads each new tutor reply with the same player once it finishes, starting with the section title. Only replies written while the screen is open are read, so returning to a unit does not read its history. The choice is kept in the browser. Starting a section's own Read aloud stops it, and so does the mic.

The mic beside the question box turns a spoken question into text on the Mac. The browser records only while the mic is on, then mixes the recording to mono, resamples it to 16 kHz and encodes 16-bit PCM WAV (`lib/speech-wav.ts`), so the server needs no audio decoder. `/api/audio/transcribe` passes it to a second Python worker (`scripts/speech-to-text-worker.py`) in the Kokoro environment, which runs NVIDIA's Parakeet TDT 0.6B v2 (English, int8) on onnxruntime through `onnx-asr`. The text goes into the question box to edit or send. Recordings are capped at two minutes, written to a private temporary folder for the worker and deleted straight after; nothing is sent off the Mac.

Cancelling a queued transcription creates no temporary files. If inference has already started, its files stay available until the worker finishes, then both recording and transcript are deleted even though the caller has left.

The first use downloads the model, about 630 MB, into `speech-to-text/` in the Kokoro data folder, so startup allows up to 20 minutes. The mic warms the worker as recording starts. Once loaded it stays up for five idle minutes, and a short question takes under a second to transcribe. Set `BLITZ_SPEECH_TO_TEXT_MODEL` to try another `onnx-asr` model. After pulling this change, run `scripts/setup-kokoro.sh` again to install `onnx-asr`. macOS asks for microphone access the first time.
