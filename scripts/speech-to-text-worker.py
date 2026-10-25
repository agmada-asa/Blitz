"""Keep a local speech-to-text model loaded and transcribe newline-delimited requests.

Blitz runs this beside the Kokoro worker, in the same private Python
environment (scripts/setup-kokoro.sh). It speaks the same protocol: one
`{"ready": ...}` line after startup, then one `{"ok": ...}` line per request.
Each request names a 16 kHz mono PCM WAV file to read and a text file to write
the transcript to. Nothing leaves the Mac: the model runs on onnxruntime, and
only its files are downloaded, once, into the Blitz data directory.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path

#: English Parakeet TDT, int8: accurate on technical terms and fast on a CPU.
DEFAULT_MODEL = "nemo-parakeet-tdt-0.6b-v2"


def watch_parent(parent_pid: int) -> None:
    """Exit even during native inference if the owning Node server disappears."""
    while True:
        if os.getppid() != parent_pid or parent_pid == 1:
            # A signal handler may wait for native inference to return; _exit does not.
            os._exit(1)
        time.sleep(1)


def initialize(data_dir: Path):
    """Load the CPU-bounded model, downloading its files only when missing."""
    # Set numerical-library limits before importing ONNX or NumPy.
    for variable in (
        "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
        "VECLIB_MAXIMUM_THREADS", "NUMEXPR_NUM_THREADS",
    ):
        os.environ[variable] = "2"
    # Model files live with Kokoro's, not in the shared Hugging Face cache.
    os.environ["HF_HUB_CACHE"] = str(data_dir / "speech-to-text")
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    try:
        import onnxruntime as rt
        import onnx_asr
    except ImportError as error:
        raise RuntimeError(
            "Speech to text is not installed. Run scripts/setup-kokoro.sh, then restart Blitz."
        ) from error

    options = rt.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    options.add_session_config_entry("session.inter_op.allow_spinning", "0")
    model = os.environ.get("BLITZ_SPEECH_TO_TEXT_MODEL", "").strip() or DEFAULT_MODEL
    return onnx_asr.load_model(
        model,
        quantization="int8",
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )


def main() -> None:
    """Serve sequential requests while Node enforces inference and idle deadlines."""
    threading.Thread(target=watch_parent, args=(os.getppid(),), daemon=True).start()
    data_dir = Path(os.environ["BLITZ_KOKORO_DIR"]).expanduser()
    try:
        model = initialize(data_dir)
    except Exception as error:
        print(json.dumps({"ready": False, "error": str(error)}), flush=True)
        return

    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            input_path = Path(request.get("inputPath", ""))
            output_path = Path(request.get("outputPath", ""))
            if not input_path.is_absolute() or not input_path.is_file():
                raise ValueError("The recording could not be found.")
            if not output_path.is_absolute():
                raise ValueError("Transcript output path must be absolute.")
            text = model.recognize(str(input_path))
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(str(text).strip(), encoding="utf-8")
            print(json.dumps({"ok": True}), flush=True)
        except Exception as error:
            print(json.dumps({"ok": False, "error": str(error)}), flush=True)


if __name__ == "__main__":
    main()
