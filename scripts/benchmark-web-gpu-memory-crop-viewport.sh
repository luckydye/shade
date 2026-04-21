#!/usr/bin/env bash
# Usage examples:
#   scripts/benchmark-web-gpu-memory-crop-viewport.sh
#   scripts/benchmark-web-gpu-memory-crop-viewport.sh --fixture /abs/path/to/image.CR3
#   scripts/benchmark-web-gpu-memory-crop-viewport.sh --zoom 2.5 --pan-dx 320 --pan-dy 160 --pan-steps 12
#   scripts/benchmark-web-gpu-memory-crop-viewport.sh --server-info "$HOME/Library/Application Support/com.shade.editor/remote-control-server.json"

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$ROOT_DIR/test/fixtures/_MGC3030.CR3"
SESSION="gpu-bench-crop-viewport-$(date +%s)"
OUT_DIR="/tmp/$SESSION"
CROP_X=240
CROP_Y=180
CROP_WIDTH=1800
CROP_HEIGHT=1200
CROP_ROTATION=0
VIEWPORT_ZOOM=2
PAN_DX=240
PAN_DY=140
PAN_STEPS=8
PAN_UNIT="screen"
WAIT_FOR_SERVER_MS=15000
WAIT_AFTER_OPEN_MS=5000
WAIT_AFTER_ACTION_MS=300
SERVER_INFO=""
SERVER_ADDRESS=""

function require_command() {
  local name="$1"
  command -v "$name" >/dev/null 2>&1 || {
    echo "missing required command: $name" >&2
    exit 1
  }
}

function default_server_info_path() {
  if [[ "$OSTYPE" == darwin* ]]; then
    printf '%s/Library/Application Support/com.shade.editor/remote-control-server.json' "$HOME"
    return
  fi
  printf '%s/.config/com.shade.editor/remote-control-server.json' "$HOME"
}

function ms_sleep() {
  local duration_ms="$1"
  python3 - "$duration_ms" <<'PY'
import sys
import time

time.sleep(float(sys.argv[1]) / 1000.0)
PY
}

function parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --fixture)
        FIXTURE="$2"
        shift 2
        ;;
      --session)
        SESSION="$2"
        shift 2
        ;;
      --out-dir)
        OUT_DIR="$2"
        shift 2
        ;;
      --server-info)
        SERVER_INFO="$2"
        shift 2
        ;;
      --wait-for-server-ms)
        WAIT_FOR_SERVER_MS="$2"
        shift 2
        ;;
      --wait-after-open-ms)
        WAIT_AFTER_OPEN_MS="$2"
        shift 2
        ;;
      --wait-after-action-ms)
        WAIT_AFTER_ACTION_MS="$2"
        shift 2
        ;;
      --crop-x)
        CROP_X="$2"
        shift 2
        ;;
      --crop-y)
        CROP_Y="$2"
        shift 2
        ;;
      --crop-width)
        CROP_WIDTH="$2"
        shift 2
        ;;
      --crop-height)
        CROP_HEIGHT="$2"
        shift 2
        ;;
      --crop-rotation)
        CROP_ROTATION="$2"
        shift 2
        ;;
      --zoom)
        VIEWPORT_ZOOM="$2"
        shift 2
        ;;
      --pan-dx)
        PAN_DX="$2"
        shift 2
        ;;
      --pan-dy)
        PAN_DY="$2"
        shift 2
        ;;
      --pan-steps)
        PAN_STEPS="$2"
        shift 2
        ;;
      --pan-unit)
        PAN_UNIT="$2"
        shift 2
        ;;
      *)
        echo "unknown argument: $1" >&2
        exit 1
        ;;
    esac
  done
}

function read_server_address() {
  python3 - "$SERVER_INFO" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
data = json.loads(path.read_text())
address = data.get("address")
if not isinstance(address, str) or not address:
    raise SystemExit(f"invalid remote control server address in {path}")
print(address)
PY
}

function wait_for_server_info() {
  local attempts
  local attempt
  attempts=$((WAIT_FOR_SERVER_MS / 250))
  if (( attempts <= 0 )); then
    attempts=1
  fi
  for attempt in $(seq 1 "$attempts"); do
    if [[ -f "$SERVER_INFO" ]]; then
      SERVER_ADDRESS="$(read_server_address)"
      if [[ -n "$SERVER_ADDRESS" ]]; then
        return 0
      fi
    fi
    ms_sleep 250
  done
  echo "remote control server info not found: $SERVER_INFO" >&2
  echo "start Shade Tauri app first" >&2
  exit 1
}

function rpc_request() {
  local request_json="$1"
  python3 - "$SERVER_ADDRESS" "$request_json" <<'PY'
import json
import socket
import sys

address = sys.argv[1]
request = json.loads(sys.argv[2])
host, port = address.rsplit(":", 1)
with socket.create_connection((host, int(port)), timeout=30) as sock:
    sock.sendall((json.dumps(request) + "\n").encode("utf-8"))
    if "id" not in request:
        raise SystemExit(0)
    line = sock.makefile("r", encoding="utf-8").readline()
if not line:
    raise SystemExit("remote control server closed connection without response")
print(line.rstrip("\n"))
PY
}

function initialize_remote_control() {
  rpc_request "$(python3 - <<'PY'
import json
import uuid

print(json.dumps({
    "jsonrpc": "2.0",
    "id": str(uuid.uuid4()),
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {
            "name": "shade-benchmark-crop-viewport",
            "version": "1.0.0",
        },
    },
}))
PY
)" >/dev/null
  rpc_request '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' >/dev/null
}

function tool_call() {
  local name="$1"
  local arguments_json="$2"
  python3 - "$SERVER_ADDRESS" "$name" "$arguments_json" <<'PY'
import json
import socket
import sys
import uuid

address, name, arguments_json = sys.argv[1:4]
host, port = address.rsplit(":", 1)
request = {
    "jsonrpc": "2.0",
    "id": str(uuid.uuid4()),
    "method": "tools/call",
    "params": {
        "name": name,
        "arguments": json.loads(arguments_json),
    },
}
with socket.create_connection((host, int(port)), timeout=30) as sock:
    sock.sendall((json.dumps(request) + "\n").encode("utf-8"))
    line = sock.makefile("r", encoding="utf-8").readline()
if not line:
    raise SystemExit("remote control server closed connection without response")
response = json.loads(line)
if response.get("error"):
    raise SystemExit(response["error"].get("message", "remote control request failed"))
result = response.get("result", {})
if result.get("isError"):
    text = "\n".join(
        item.get("text", "")
        for item in result.get("content", [])
        if item.get("type") == "text"
    ).strip()
    raise SystemExit(text or f"remote control tool failed: {name}")
print(json.dumps(result.get("structuredContent"), separators=(",", ":")))
PY
}

function log_step() {
  local step="$1"
  local response_json="$2"
  python3 - "$step" "$response_json" "$OUT_DIR/steps.jsonl" <<'PY'
import json
import pathlib
import sys

step, response_json, output_path = sys.argv[1:4]
entry = {
    "step": step,
    "response": json.loads(response_json),
}
path = pathlib.Path(output_path)
with path.open("a", encoding="utf-8") as handle:
    handle.write(json.dumps(entry) + "\n")
PY
}

function tool_call_logged() {
  local step="$1"
  local name="$2"
  local arguments_json="$3"
  local response_json
  response_json="$(tool_call "$name" "$arguments_json")"
  log_step "$step" "$response_json"
  printf '%s\n' "$response_json"
}

function extract_json_field() {
  local json_input="$1"
  local field_path="$2"
  python3 - "$json_input" "$field_path" <<'PY'
import json
import sys

value = json.loads(sys.argv[1])
for part in sys.argv[2].split("."):
    value = value[part]
if isinstance(value, float):
    print(f"{value:.6f}")
else:
    print(value)
PY
}

function centered_value() {
  local start="$1"
  local span="$2"
  awk -v start="$start" -v span="$span" 'BEGIN { printf "%.6f\n", start + (span / 2.0) }'
}

parse_args "$@"

require_command python3

SERVER_INFO="${SERVER_INFO:-$(default_server_info_path)}"

[[ -f "$FIXTURE" ]] || {
  echo "fixture not found: $FIXTURE" >&2
  exit 1
}
[[ "$WAIT_FOR_SERVER_MS" =~ ^[0-9]+$ && "$WAIT_FOR_SERVER_MS" -gt 0 ]] || {
  echo "--wait-for-server-ms must be positive integer" >&2
  exit 1
}
[[ "$WAIT_AFTER_OPEN_MS" =~ ^[0-9]+$ && "$WAIT_AFTER_OPEN_MS" -ge 0 ]] || {
  echo "--wait-after-open-ms must be non-negative integer" >&2
  exit 1
}
[[ "$WAIT_AFTER_ACTION_MS" =~ ^[0-9]+$ && "$WAIT_AFTER_ACTION_MS" -ge 0 ]] || {
  echo "--wait-after-action-ms must be non-negative integer" >&2
  exit 1
}
[[ "$PAN_STEPS" =~ ^[0-9]+$ && "$PAN_STEPS" -gt 0 ]] || {
  echo "--pan-steps must be positive integer" >&2
  exit 1
}
[[ "$PAN_UNIT" == "screen" || "$PAN_UNIT" == "image" ]] || {
  echo "--pan-unit must be screen or image" >&2
  exit 1
}

mkdir -p "$OUT_DIR"

cat >"$OUT_DIR/metadata.txt" <<EOF
session=$SESSION
fixture=$FIXTURE
server_info=$SERVER_INFO
crop_x=$CROP_X
crop_y=$CROP_Y
crop_width=$CROP_WIDTH
crop_height=$CROP_HEIGHT
crop_rotation=$CROP_ROTATION
viewport_zoom=$VIEWPORT_ZOOM
pan_dx=$PAN_DX
pan_dy=$PAN_DY
pan_steps=$PAN_STEPS
pan_unit=$PAN_UNIT
wait_for_server_ms=$WAIT_FOR_SERVER_MS
wait_after_open_ms=$WAIT_AFTER_OPEN_MS
wait_after_action_ms=$WAIT_AFTER_ACTION_MS
started_at=$(date '+%Y-%m-%dT%H:%M:%S%z')
EOF

wait_for_server_info
echo "server_address=$SERVER_ADDRESS" >>"$OUT_DIR/metadata.txt"

initialize_remote_control

tool_call_logged "before" "get_app_state" '{}' >"$OUT_DIR/state-before.json"

tool_call_logged \
  "open_image_path" \
  "open_image_path" \
  "$(python3 - "$FIXTURE" <<'PY'
import json
import sys

print(json.dumps({"path": sys.argv[1]}))
PY
)" >/dev/null

ms_sleep "$WAIT_AFTER_OPEN_MS"

crop_layer_response="$(
  tool_call_logged \
    "add_crop_layer" \
    "add_layer" \
    '{"kind":"crop"}'
)"
crop_layer_index="$(extract_json_field "$crop_layer_response" "layerIndex")"

tool_call_logged \
  "set_crop_rect" \
  "set_crop_rect" \
  "$(python3 - "$crop_layer_index" "$CROP_X" "$CROP_Y" "$CROP_WIDTH" "$CROP_HEIGHT" "$CROP_ROTATION" <<'PY'
import json
import sys

print(json.dumps({
    "layerIndex": int(sys.argv[1]),
    "x": float(sys.argv[2]),
    "y": float(sys.argv[3]),
    "width": float(sys.argv[4]),
    "height": float(sys.argv[5]),
    "rotation": float(sys.argv[6]),
}))
PY
)" >/dev/null

ms_sleep "$WAIT_AFTER_ACTION_MS"

adjustment_layer_index="$(
  tool_call "get_app_state" '{}' | python3 -c '
import json
import sys

state = json.load(sys.stdin)
for index, layer in enumerate(state["layers"]):
    if layer["kind"] == "adjustment":
        print(index)
        raise SystemExit
raise SystemExit("expected at least one adjustment layer after adding crop layer")
'
)"

tool_call_logged \
  "select_adjustment_layer" \
  "select_layer" \
  "$(python3 - "$adjustment_layer_index" <<'PY'
import json
import sys

print(json.dumps({
    "layerIndex": int(sys.argv[1]),
}))
PY
)" >/dev/null

ms_sleep "$WAIT_AFTER_ACTION_MS"

VIEWPORT_CENTER_X="$(centered_value "$CROP_X" "$CROP_WIDTH")"
VIEWPORT_CENTER_Y="$(centered_value "$CROP_Y" "$CROP_HEIGHT")"

tool_call_logged \
  "set_viewport" \
  "set_viewport" \
  "$(python3 - "$VIEWPORT_CENTER_X" "$VIEWPORT_CENTER_Y" "$VIEWPORT_ZOOM" <<'PY'
import json
import sys

print(json.dumps({
    "centerX": float(sys.argv[1]),
    "centerY": float(sys.argv[2]),
    "zoom": float(sys.argv[3]),
}))
PY
)" >/dev/null

ms_sleep "$WAIT_AFTER_ACTION_MS"

for step in $(seq 1 "$PAN_STEPS"); do
  if (( step % 2 == 1 )); then
    current_dx="$PAN_DX"
    current_dy="$PAN_DY"
  else
    current_dx="$(awk -v value="$PAN_DX" 'BEGIN { printf "%.6f\n", -value }')"
    current_dy="$(awk -v value="$PAN_DY" 'BEGIN { printf "%.6f\n", -value }')"
  fi
  tool_call_logged \
    "pan_viewport_$step" \
    "pan_viewport" \
    "$(python3 - "$current_dx" "$current_dy" "$PAN_UNIT" <<'PY'
import json
import sys

print(json.dumps({
    "deltaX": float(sys.argv[1]),
    "deltaY": float(sys.argv[2]),
    "unit": sys.argv[3],
}))
PY
)" >/dev/null
  ms_sleep "$WAIT_AFTER_ACTION_MS"
done

tool_call_logged "after" "get_app_state" '{}' >"$OUT_DIR/state-after.json"

cat <<EOF
crop viewport script complete
  out_dir: $OUT_DIR
  fixture: $FIXTURE
  server_info: $SERVER_INFO
  server_address: $SERVER_ADDRESS
  crop_layer_index: $crop_layer_index
  adjustment_layer_index: $adjustment_layer_index
  viewport_zoom: $VIEWPORT_ZOOM
  pan_steps: $PAN_STEPS
EOF
