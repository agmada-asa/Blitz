"""Join Kokoro PCM WAV chunks into one project episode without loading them all into RAM."""

from __future__ import annotations

import json
import os
import sys
import wave
from pathlib import Path


def join_wav(output: Path, parts: list[Path]) -> None:
    """Write compatible source frames atomically; fail on an empty or mismatched part."""
    if not parts:
        raise ValueError("At least one audio part is required")
    temporary = output.with_suffix(output.suffix + ".partial")
    temporary.parent.mkdir(parents=True, exist_ok=True)
    expected: tuple[int, int, int, str] | None = None
    try:
        with wave.open(str(temporary), "wb") as destination:
            for part in parts:
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
                    while frames := source.readframes(24_000):
                        destination.writeframes(frames)
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: join-wav.py OUTPUT < JSON_PART_PATHS")
    join_wav(Path(sys.argv[1]), [Path(part) for part in json.load(sys.stdin)])
