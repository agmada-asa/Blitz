"""Join Kokoro PCM WAV chunks into one project episode without loading them all into RAM."""

from __future__ import annotations

import json
import os
import sys
import wave
from pathlib import Path


def join_wav(output: Path, parts: list[dict[str, object]]) -> None:
    """Join compatible frames and put a short silence before section starts."""
    if not parts:
        raise ValueError("At least one audio part is required")
    temporary = output.with_suffix(output.suffix + ".partial")
    temporary.parent.mkdir(parents=True, exist_ok=True)
    expected: tuple[int, int, int, str] | None = None
    try:
        with wave.open(str(temporary), "wb") as destination:
            for entry in parts:
                part = Path(str(entry["path"]))
                pause_seconds = float(entry.get("pauseBeforeSeconds", 0))
                if pause_seconds < 0 or pause_seconds > 2:
                    raise ValueError("Section pause is invalid")
                with wave.open(str(part), "rb") as source:
                    details = (
                        source.getnchannels(),
                        source.getsampwidth(),
                        source.getframerate(),
                        source.getcomptype(),
                    )
                    if source.getnframes() == 0:
                        raise ValueError(f"Audio part is empty: {part.name}")
                    if expected is None:
                        expected = details
                        destination.setparams(source.getparams())
                    elif details != expected:
                        raise ValueError(f"Audio part format changed: {part.name}")
                    if pause_seconds:
                        frames = round(pause_seconds * source.getframerate())
                        frame_bytes = source.getnchannels() * source.getsampwidth()
                        destination.writeframes(b"\0" * frames * frame_bytes)
                    while frames := source.readframes(24_000):
                        destination.writeframes(frames)
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: join-wav.py OUTPUT < JSON_PARTS")
    join_wav(Path(sys.argv[1]), json.load(sys.stdin))
