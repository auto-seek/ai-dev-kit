#!/bin/bash
# Download the pinned Godot .NET and .NET SDK archives for one architecture
# from their official release hosts into downloads/, keeping only files that
# match SHA512SUMS (Godot's SHA512-SUMS.txt and Microsoft's releases.json for
# these versions). The Dockerfile checks them again before unpacking.
#   fetch.sh [arm64|amd64]   (default: this machine's architecture)
set -euo pipefail
GODOT_VERSION=4.7.1-stable
DOTNET_SDK=8.0.129
here=$(cd "$(dirname "$0")" && pwd)
case ${1:-$(uname -m)} in
  arm64|aarch64) godot=linux_arm64 dotnet=linux-arm64 ;;
  amd64|x86_64) godot=linux_x86_64 dotnet=linux-x64 ;;
  *) echo "usage: fetch.sh [arm64|amd64]" >&2; exit 2 ;;
esac
if command -v sha512sum >/dev/null; then sum() { sha512sum "$@"; }; else sum() { shasum -a 512 "$@"; }; fi
mkdir -p "$here/downloads"
cd "$here/downloads"
for pair in \
  "Godot_v${GODOT_VERSION}_mono_${godot}.zip https://github.com/godotengine/godot-builds/releases/download/${GODOT_VERSION}" \
  "dotnet-sdk-${DOTNET_SDK}-${dotnet}.tar.gz https://builds.dotnet.microsoft.com/dotnet/Sdk/${DOTNET_SDK}"; do
  file=${pair%% *} base=${pair#* }
  expected=$(awk -v f="$file" '$2 == f {print $1}' "$here/SHA512SUMS")
  [ -n "$expected" ] || { echo "fetch.sh: $file is not listed in SHA512SUMS" >&2; exit 1; }
  if [ -f "$file" ] && [ "$(sum "$file" | cut -d' ' -f1)" = "$expected" ]; then echo "ok (cached) $file"; continue; fi
  curl -fL --retry 5 -o "$file.part" "$base/$file"
  actual=$(sum "$file.part" | cut -d' ' -f1)
  [ "$actual" = "$expected" ] || { rm -f "$file.part"; echo "fetch.sh: SHA512 mismatch for $file" >&2; exit 1; }
  mv "$file.part" "$file"
  echo "ok $file"
done
