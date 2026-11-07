"""Local voice turn detection using Silero VAD and Smart Turn.

The voice service (voice-service.ts) starts one of these per call and talks to it one JSON line
at a time. It decides when someone is speaking and when they have finished a
turn; the speech-to-text and Kokoro workers handle recognition and synthesis.

In:
  {"pcm": "<base64>"}   16 kHz, 16-bit mono audio, any length, in order.
  {"config": {...}}     any of "start_ms", "pause_ms", "recheck_ms", "threshold".
  {"end": true, "epoch": n}
                        the host took the turn: forget its audio and listen afresh. Every later
                        event carries "epoch": n, so the host can drop events about the old turn
                        that were already on their way.

Out:
  {"ready": true}                              once both models are loaded.
  {"event": "speech", "at": s}                 speech started, s seconds into the call.
  {"event": "pause", "silence_ms": m, "at": s} speech stopped; m ms of silence so far.
  {"event": "turn", "p": p, "ms": t, "silence_ms": m}
                                               Smart Turn's chance the turn is over, p in
                                               0..1, taking t ms; sent at the first pause
                                               and again every recheck_ms of silence.
  {"event": "resume"}                          speech started again before the host took the turn.

argv[1] is the folder holding silero_vad.onnx and smart-turn-v3.2-cpu.onnx.
It stops when the voice service closes its stdin.
"""

import base64
import json
import os
import sys
import time
import threading
from kokoro_worker_support import watch_parent

threading.Thread(target=watch_parent, args=(os.getppid(),), daemon=True).start()

# Two threads each: the call shares the Mac with Whisper and Kokoro.
for variable in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ[variable] = "2"

import numpy as np
import onnxruntime as rt
from mlx_whisper.audio import log_mel_spectrogram

RATE = 16_000
# Silero v5 takes 512 new samples at 16 kHz, after the last 64 of the chunk before.
CHUNK = 512
CONTEXT = 64
CHUNK_MS = CHUNK * 1000 / RATE
# Smart Turn reads the last 8 s of a turn.
TURN_SAMPLES = 8 * RATE
# Audio kept from before speech was detected, so the first syllable isn't lost.
PRE_ROLL = int(0.3 * RATE)

settings = {
    # Voiced audio needed before it counts as speech (filters clicks and coughs).
    "start_ms": 96,
    # Silence after speech before Smart Turn is first asked.
    "pause_ms": 200,
    # Further silence between later asks, as more silence makes an ending likelier.
    "recheck_ms": 400,
    # Silero's speech probability: above `on` is voiced; below `off` is silence (hysteresis).
    "on": 0.5,
    "off": 0.35,
}


def session(path):
    """An ONNX session for the CPU, single-threaded between operators."""
    options = rt.SessionOptions()
    options.inter_op_num_threads = 1
    options.intra_op_num_threads = 2
    options.execution_mode = rt.ExecutionMode.ORT_SEQUENTIAL
    options.graph_optimization_level = rt.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    return rt.InferenceSession(path, sess_options=options, providers=["CPUExecutionProvider"])


models = sys.argv[1]
vad = session(os.path.join(models, "silero_vad.onnx"))
turn_model = session(os.path.join(models, "smart-turn-v3.2-cpu.onnx"))


class Silero:
    """Silero VAD v5 over a stream of 512-sample chunks, carrying its state and context."""

    def __init__(self):
        """Initialize recurrent state for a fresh microphone stream."""
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.context = np.zeros((1, CONTEXT), dtype=np.float32)
        self.sr = np.array(RATE, dtype=np.int64)

    def prob(self, chunk):
        """The chance [chunk] (512 float samples) is speech."""
        x = np.concatenate([self.context, chunk[np.newaxis, :]], axis=1)
        out, self.state = vad.run(None, {"input": x, "state": self.state, "sr": self.sr})
        self.context = x[:, -CONTEXT:]
        return float(out[0][0])


def turn_probability(audio):
    """Smart Turn v3's chance that [audio] (float samples of the turn so far) ends a turn.

    Mirrors pipecat-ai/smart-turn's inference.py: the last 8 s, zero-padded at the
    start, normalised to zero mean and unit variance over all 8 s, then Whisper's
    80-band log-mel features. mlx-whisper's log_mel_spectrogram computes the same
    features as transformers' WhisperFeatureExtractor, without needing transformers.
    """
    audio = audio[-TURN_SAMPLES:]
    if len(audio) < TURN_SAMPLES:
        audio = np.pad(audio, (TURN_SAMPLES - len(audio), 0))
    audio = (audio - audio.mean()) / np.sqrt(audio.var() + 1e-7)
    features = np.array(log_mel_spectrogram(audio.astype(np.float32), n_mels=80)).T[:, :800]
    out = turn_model.run(None, {"input_features": features[np.newaxis].astype(np.float32)})
    return float(out[0].reshape(-1)[0])


epoch = 0  # turns the host has taken; stamped on every event


def emit(message):
    """Writes one JSON line to the voice service, stamped with the current turn epoch."""
    print(json.dumps({**message, "epoch": epoch}), flush=True)


silero = Silero()
# Warm both models so the first real turn isn't slow.
silero.prob(np.zeros(CHUNK, dtype=np.float32))
turn_probability(np.zeros(RATE, dtype=np.float32))
silero = Silero()
emit({"ready": True})

pending = np.zeros(0, dtype=np.float32)  # samples not yet a whole chunk
heard = 0  # samples processed since the call started
recent = np.zeros(0, dtype=np.float32)  # the last PRE_ROLL samples, for the next turn's start
turn = []  # chunks of the turn in progress, pre-roll included
speaking = False  # inside a stretch of speech
in_turn = False  # speech heard that the host hasn't taken yet
voiced_ms = 0.0  # voiced audio in a row while not yet speaking
silence_ms = 0.0  # silence since speech last stopped
next_ask_ms = 0.0  # silence at which Smart Turn is next asked

for line in sys.stdin:
    request = json.loads(line)
    if "config" in request:
        settings.update({key: float(value) for key, value in request["config"].items() if key in settings})
        continue
    if request.get("end"):
        epoch = int(request.get("epoch", epoch + 1))
        turn, in_turn, speaking, voiced_ms, silence_ms = [], False, False, 0.0, 0.0
        continue
    samples = np.frombuffer(base64.b64decode(request["pcm"]), dtype="<i2").astype(np.float32) / 32768
    pending = np.concatenate([pending, samples])
    while len(pending) >= CHUNK:
        chunk, pending = pending[:CHUNK], pending[CHUNK:]
        heard += CHUNK
        p = silero.prob(chunk)
        if in_turn:
            turn.append(chunk)
        else:
            recent = np.concatenate([recent, chunk])[-PRE_ROLL:]

        if not speaking:
            voiced_ms = voiced_ms + CHUNK_MS if p >= settings["on"] else 0.0
            if voiced_ms >= settings["start_ms"]:
                speaking = True
                silence_ms = 0.0
                if in_turn:
                    emit({"event": "resume"})
                else:
                    in_turn = True
                    turn = [recent.copy()]
                    recent = np.zeros(0, dtype=np.float32)
                    emit({"event": "speech", "at": round((heard / RATE) - voiced_ms / 1000, 3)})
            elif in_turn:
                silence_ms += CHUNK_MS
        elif p < settings["off"]:
            speaking = False
            voiced_ms = 0.0
            silence_ms = CHUNK_MS
            next_ask_ms = settings["pause_ms"]
            emit({"event": "pause", "silence_ms": 0, "at": round(heard / RATE, 3)})

        # Ask Smart Turn at the first pause, then again as the silence grows.
        if in_turn and not speaking and silence_ms >= next_ask_ms:
            started = time.perf_counter()
            probability = turn_probability(np.concatenate(turn))
            emit({
                "event": "turn",
                "p": round(probability, 3),
                "ms": round((time.perf_counter() - started) * 1000, 1),
                "silence_ms": round(silence_ms),
            })
            next_ask_ms = silence_ms + settings["recheck_ms"]
