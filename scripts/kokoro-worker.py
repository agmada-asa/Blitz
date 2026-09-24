"""Keep Kokoro loaded once and serve newline-delimited local synthesis requests."""

from __future__ import annotations

import json
import os
import shutil
import ssl
import sys
import urllib.request
from pathlib import Path

import certifi


MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.onnx"
VOICES_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin"


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
    """Load Kokoro and its voice catalogue, downloading model files on first use."""
    try:
        import soundfile as sf
        from kokoro_onnx import Kokoro
    except ImportError as error:
        raise RuntimeError(
            "Kokoro is not installed. Run scripts/setup-kokoro.sh, then restart Blitz."
        ) from error

    model_path = data_dir / "kokoro-v1.0.onnx"
    voices_path = data_dir / "voices-v1.0.bin"
    ensure_asset(model_path, MODEL_URL)
    ensure_asset(voices_path, VOICES_URL)
    return Kokoro(str(model_path), str(voices_path)), sf


def main() -> None:
    """Process requests sequentially while keeping the ONNX model resident in memory."""
    data_dir = Path(os.environ["BLITZ_KOKORO_DIR"]).expanduser()
    try:
        kokoro, soundfile = initialize(data_dir)
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
