#!/usr/bin/env bash
# Requires: wasm-pack (https://rustwasm.github.io/wasm-pack/installer/)
set -euo pipefail
cd "$(dirname "$0")/.."
wasm-pack build crates/shade-wasm \
  --target web \
  --out-dir ../../ui/wasm \
  --release
echo "WASM build complete → ui/wasm/"
