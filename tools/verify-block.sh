#!/bin/bash
# Prints the "Verify what you install" block for a GitHub release body:
# sha256 of each signed artifact and the APK's signing certificate digest.
#   tools/verify-block.sh dist/magpie-<version>.apk [dist/magpie-<version>.aab]
set -euo pipefail

APK=${1:?usage: tools/verify-block.sh APK [AAB]}
AAB=${2:-}
SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
APKSIGNER="${APKSIGNER:-$SDK/build-tools/34.0.0/apksigner}"

cert=$("$APKSIGNER" verify --print-certs "$APK" 2>/dev/null | sed -n 's/^Signer #1 certificate SHA-256 digest: //p') || true
[ -n "$cert" ] || { echo "could not read a signing certificate from $APK" >&2; exit 1; }
apk_name=$(basename "$APK")

echo '**Verify what you install**'
echo
echo '```'
echo "sha256 $apk_name  $(sha256sum "$APK" | cut -d' ' -f1)"
[ -z "$AAB" ] || echo "sha256 $(basename "$AAB")  $(sha256sum "$AAB" | cut -d' ' -f1)"
echo "signing cert sha256  $cert"
echo '```'
echo
echo "\`magpie.apk\` is the same file as \`$apk_name\` under a stable name. To check it against this tag's source, build it unsigned (\`cd android && ./gradlew assembleRelease\`) and run \`python3 tools/compare-apk.py android/app/build/outputs/apk/release/app-release-unsigned.apk $apk_name\`."
