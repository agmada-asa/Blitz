"""Persistent local Whisper transcription with single-pass decoding and noise filtering."""

import json
import os
import sys
import threading
import contextlib
from pathlib import Path
from kokoro_worker_support import watch_parent


def invented(segment):
    """Reject repetitive or low-confidence segments produced from silence."""
    return segment.get("compression_ratio", 0) > 2.4 or (
        segment.get("no_speech_prob", 0) > 0.6 and segment.get("avg_logprob", 0) < -1
    )


def main():
    """Warm Whisper once, then transcribe WAV paths using the shared worker protocol."""
    threading.Thread(target=watch_parent, args=(os.getppid(),), daemon=True).start()
    try:
        import mlx_whisper
        import numpy as np
        model = os.environ.get("BLITZ_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
        with contextlib.redirect_stdout(sys.stderr):
            mlx_whisper.transcribe(np.zeros(16000, dtype=np.float32), path_or_hf_repo=model, temperature=0.0)
        print(json.dumps({"ready": True}), flush=True)
    except Exception as error:
        print(json.dumps({"ready": False, "error": str(error)}), flush=True)
        return
    for line in sys.stdin:
        try:
            request = json.loads(line)
            result = mlx_whisper.transcribe(
                request["inputPath"], path_or_hf_repo=model, temperature=0.0,
                initial_prompt=str(request.get("prompt", ""))[:2000] or None,
                condition_on_previous_text=False,
            )
            text = " ".join(s["text"].strip() for s in result["segments"] if not invented(s))
            Path(request["outputPath"]).write_text(text.strip(), encoding="utf-8")
            print(json.dumps({"ok": True}), flush=True)
        except Exception as error:
            print(json.dumps({"ok": False, "error": str(error)}), flush=True)


if __name__ == "__main__":
    main()
