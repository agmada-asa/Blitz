"""Exercise the real parent watchdog while fake native inference blocks for a minute."""

import runpy
import sys
import time
import types
from pathlib import Path

# This lifecycle test needs neither downloaded models nor installed speech packages.
sys.modules["certifi"] = types.ModuleType("certifi")
worker = runpy.run_path(str(Path(__file__).parents[2] / "scripts/kokoro-worker.py"))


class StalledModel:
    """Complete warmup, then block where production ONNX inference would run."""

    def create(self, text: str, **_options):
        """Allow readiness and advertise the stalled inference before releasing the GIL."""
        if text == "Ready.":
            return None
        print('{"busy": true}', flush=True)
        time.sleep(60)
        raise RuntimeError("Parent watchdog did not stop the worker.")


def initialize(_data_dir):
    """Supply a stalled model without loading CPU-intensive assets."""
    return StalledModel(), None


worker["main"].__globals__["initialize"] = initialize
worker["main"]()
