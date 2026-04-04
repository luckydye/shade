#!/usr/bin/env bash
# Requires: wasm-pack (https://rustwasm.github.io/wasm-pack/installer/)
set -euo pipefail
cd "$(dirname "$0")/.."
wasm-pack build shade-wasm \
  --target web \
  --out-dir pkg \
  --dev
echo "WASM dev build complete -> shade-wasm/pkg/"
