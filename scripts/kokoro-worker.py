"""Keep Kokoro loaded once and serve newline-delimited local synthesis requests."""

from __future__ import annotations

import json
import os
import shutil
import ssl
import sys
import threading
import time
import urllib.request
from pathlib import Path

import certifi


MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.onnx"
VOICES_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin"


def watch_parent(parent_pid: int) -> None:
    """Exit even during native inference if the owning Node server disappears."""
    while True:
        if os.getppid() != parent_pid or parent_pid == 1:
            # A signal handler may wait for native inference to return; _exit does not.
            os._exit(1)
        time.sleep(1)


def ensure_asset(path: Path, url: str) -> None:
    """Download one missing model asset atomically into the configured user data directory."""
    if path.is_file() and path.stat().st_size > 0:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".download")
    try:
        context = ssl.create_default_context(cafile=certifi.where())
        with urllib.request.urlopen(url, context=context, timeout=60) as response:
            with temporary.open("wb") as destination:
                shutil.copyfileobj(response, destination)
        temporary.replace(path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def initialize(data_dir: Path):
    """Load CPU-bounded Kokoro, downloading model files only when missing."""
    # Set numerical-library limits before importing ONNX, NumPy, or Kokoro.
    for variable in (
        "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
        "VECLIB_MAXIMUM_THREADS", "NUMEXPR_NUM_THREADS",
    ):
        os.environ[variable] = "2"
    try:
        import soundfile as sf
        import onnxruntime as rt
        from kokoro_onnx import Kokoro
    except ImportError as error:
        raise RuntimeError(
            "Kokoro is not installed. Run scripts/setup-kokoro.sh, then restart Blitz."
        ) from error

    model_path = data_dir / "kokoro-v1.0.onnx"
    voices_path = data_dir / "voices-v1.0.bin"
    ensure_asset(model_path, MODEL_URL)
    ensure_asset(voices_path, VOICES_URL)
    options = rt.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.execution_mode = rt.ExecutionMode.ORT_SEQUENTIAL
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    options.add_session_config_entry("session.inter_op.allow_spinning", "0")
    session = rt.InferenceSession(
        str(model_path), sess_options=options, providers=["CPUExecutionProvider"]
    )
    return Kokoro.from_session(session, str(voices_path)), sf


def main() -> None:
    """Serve sequential requests while Node enforces inference and idle deadlines."""
    threading.Thread(target=watch_parent, args=(os.getppid(),), daemon=True).start()
    data_dir = Path(os.environ["BLITZ_KOKORO_DIR"]).expanduser()
    try:
        kokoro, soundfile = initialize(data_dir)
        # Exercise phonemization and first inference before advertising readiness.
        kokoro.create("Ready.", voice="af_heart", speed=1.0, lang="en-us")
    except Exception as error:
        print(json.dumps({"ready": False, "error": str(error)}), flush=True)
        return

    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            text = request.get("text")
            voice_id = request.get("voiceId")
            output_path = Path(request.get("outputPath", ""))
            if not isinstance(text, str) or not text.strip():
                raise ValueError("Speech text must not be empty.")
            if not isinstance(voice_id, str) or not voice_id:
                raise ValueError("A Kokoro voice must be selected.")
            if not output_path.is_absolute():
                raise ValueError("Audio output path must be absolute.")

            samples, sample_rate = kokoro.create(text, voice=voice_id, speed=1.0, lang="en-us")
            output_path.parent.mkdir(parents=True, exist_ok=True)
            soundfile.write(str(output_path), samples, sample_rate, format="WAV", subtype="PCM_16")
            print(json.dumps({"ok": True}), flush=True)
        except Exception as error:
            print(json.dumps({"ok": False, "error": str(error)}), flush=True)


if __name__ == "__main__":
    main()
