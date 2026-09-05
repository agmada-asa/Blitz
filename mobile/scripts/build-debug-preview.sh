#!/usr/bin/env bash

# Builds a self-contained local preview APK with the generated debug keystore.
# Expo's default debug variant expects Metro, so this script asks the React
# Native Gradle plugin to embed JS while retaining the debug manifest and its
# cleartext LAN access. The generated Android project is removed on exit.

set -euo pipefail

mobile_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact_dir="${BLITZ_ANDROID_ARTIFACT_DIR:-${mobile_root}/../build/android}"

cd "$mobile_root"
if [[ -e android ]]; then
  echo "Refusing to run: mobile/android already exists; remove or move it before building." >&2
  exit 1
fi

export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 17)}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

# Remove only the native directory created by this invocation. A pre-existing
# directory is rejected above so a user's native work cannot be deleted.
generated_android=0
cleanup() {
  if (( generated_android == 1 )) && [[ -d android ]]; then
    rm -r android
  fi
}
trap cleanup EXIT

npx expo prebuild --platform android --no-install
generated_android=1

python3 - <<'PY'
from pathlib import Path

path = Path("android/app/build.gradle")
text = path.read_text()
marker = '    // debuggableVariants = ["liteDebug", "prodDebug"]\n'
if "    debuggableVariants = []" not in text:
    if marker not in text:
        raise SystemExit("Expo generated Gradle file has no debuggableVariants marker")
    text = text.replace(
        marker,
        marker
        + "    // Local preview: embed JS while retaining debug signing and LAN cleartext.\n"
        + "    debuggableVariants = []\n",
        1,
    )
    path.write_text(text)
PY

(cd android && ./gradlew :app:assembleDebug --no-daemon)

mkdir -p "$artifact_dir"
apk_path="$artifact_dir/blitz-android-debug.apk"
cp android/app/build/outputs/apk/debug/app-debug.apk "$apk_path"
python3 - "$apk_path" <<'PY'
from pathlib import Path
from zipfile import ZipFile
import sys

apk_path = Path(sys.argv[1])
with ZipFile(apk_path) as archive:
    if "assets/index.android.bundle" not in archive.namelist():
        raise SystemExit(f"Bundled JS asset was not found in {apk_path}")
PY
echo "Self-contained debug preview: $apk_path"
