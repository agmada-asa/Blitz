# Local Kokoro speech

Blitz runs Kokoro on the local macOS Node.js host. The first speech request downloads the Kokoro ONNX model and voice catalogue into `~/Library/Application Support/Blitz/kokoro`; later requests reuse them. The ONNX model is loaded once into a persistent Python worker for the lifetime of the Blitz Node.js process.

Install Python 3.10 through 3.13, then run `scripts/setup-kokoro.sh` from the repository. The script creates an isolated environment under the same application support directory and installs pinned packages from `scripts/kokoro-requirements.txt`. For English phonemization, install `espeak-ng` with Homebrew (`brew install espeak-ng`) if it is not already available.

Set `BLITZ_KOKORO_DIR` to move the model, voice files, and Python environment to another writable directory. Set `BLITZ_KOKORO_PYTHON` to select a Python interpreter explicitly; by default Blitz uses `venv/bin/python3` inside the data directory. The web speech route accepts text up to 12,000 characters per request. Longer audiobook and podcast jobs should split content into short chunks and call `synthesizeKokoroToFile` for each chunk.
