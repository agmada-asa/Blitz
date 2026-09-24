#!/bin/sh
# Creates the private Python environment used by Blitz's local Kokoro worker.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DATA_DIR=${BLITZ_KOKORO_DIR:-"$HOME/Library/Application Support/Blitz/kokoro"}
PYTHON=${PYTHON:-python3}

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "Python 3.10 through 3.13 is required to install local Kokoro." >&2
  exit 1
fi

mkdir -p "$DATA_DIR"
"$PYTHON" -m venv "$DATA_DIR/venv"
"$DATA_DIR/venv/bin/python3" -m pip install --upgrade pip
"$DATA_DIR/venv/bin/python3" -m pip install -r "$ROOT_DIR/scripts/kokoro-requirements.txt"

if command -v brew >/dev/null 2>&1 && ! command -v espeak-ng >/dev/null 2>&1; then
  echo "Install espeak-ng with: brew install espeak-ng" >&2
fi

echo "Kokoro Python environment installed at: $DATA_DIR/venv"
echo "Model files download on first speech request and remain in: $DATA_DIR"
