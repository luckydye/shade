#!/usr/bin/env bash
# Usage examples:
#   scripts/benchmark-web-gpu-memory.sh
#   scripts/benchmark-web-gpu-memory.sh --fixture /abs/path/to/image.CR3 --sweeps 120 --sample-every 5
#   scripts/benchmark-web-gpu-memory.sh --url http://localhost:4173/app/ --out-dir /tmp/shade-gpu-bench

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
URL="http://localhost:4173/app/"
FIXTURE="$ROOT_DIR/test/fixtures/_MGC3030.CR3"
SESSION="gpu-bench-$(date +%s)"
OUT_DIR="/tmp/$SESSION"
SLIDERS_CSV="Exposure,Gamma,Contrast,Blacks,Whites,Temperature,Tint,Vibrancy,Hue,Glow,Vignette,Sharpen,Grain,Size,Color"
SWEEPS_PER_SLIDER=8
SAMPLE_EVERY=4
WAIT_AFTER_LOAD_MS=5000
WAIT_AFTER_SLIDER_MS=250
DRAG_STEPS=24
SAMPLE_INDEX=0
TOTAL_SWEEPS=0
SLIDERS=()
TELEMETRY_FILE=""

function require_command() {
  local name="$1"
  command -v "$name" >/dev/null 2>&1 || {
    echo "missing required command: $name" >&2
    exit 1
  }
}

function contains_pid() {
  local wanted="$1"
  shift
  local current
  for current in "$@"; do
    if [[ "$current" == "$wanted" ]]; then
      return 0
    fi
  done
  return 1
}

function trim() {
  sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}

function json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

function sample_time_unix_nano() {
  perl -MTime::HiRes=time -e 'printf "%.0f\n", time() * 1000000000'
}

function size_to_bytes() {
  local value="$1"
  awk -v value="$value" '
    function multiplier(unit) {
      if (unit == "K") return 1024;
      if (unit == "M") return 1024 * 1024;
      if (unit == "G") return 1024 * 1024 * 1024;
      if (unit == "T") return 1024 * 1024 * 1024 * 1024;
      return 1;
    }
    BEGIN {
      if (value == "" || value == "0K" || value == "0M" || value == "0G" || value == "0T") {
        print "0";
        exit;
      }
      unit = substr(value, length(value), 1);
      if (unit ~ /[0-9]/) {
        unit = "";
        number = value + 0;
      } else {
        number = substr(value, 1, length(value) - 1) + 0;
      }
      printf "%.0f\n", number * multiplier(unit);
    }
  '
}

function parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --url)
        URL="$2"
        shift 2
        ;;
      --fixture)
        FIXTURE="$2"
        shift 2
        ;;
      --session)
        SESSION="$2"
        shift 2
        ;;
      --sliders)
        SLIDERS_CSV="$2"
        shift 2
        ;;
      --out-dir)
        OUT_DIR="$2"
        shift 2
        ;;
      --sweeps)
        SWEEPS_PER_SLIDER="$2"
        shift 2
        ;;
      --sweeps-per-slider)
        SWEEPS_PER_SLIDER="$2"
        shift 2
        ;;
      --sample-every)
        SAMPLE_EVERY="$2"
        shift 2
        ;;
      --wait-after-load-ms)
        WAIT_AFTER_LOAD_MS="$2"
        shift 2
        ;;
      --wait-after-slider-ms)
        WAIT_AFTER_SLIDER_MS="$2"
        shift 2
        ;;
      --drag-steps)
        DRAG_STEPS="$2"
        shift 2
        ;;
      *)
        echo "unknown argument: $1" >&2
        exit 1
        ;;
    esac
  done
}

function browser() {
  agent-browser --session "$SESSION" "$@"
}

function build_slider_list() {
  local raw_sliders=()
  local raw_slider
  local trimmed_slider
  IFS=',' read -r -a raw_sliders <<< "$SLIDERS_CSV"
  SLIDERS=()
  for raw_slider in "${raw_sliders[@]}"; do
    trimmed_slider="$(printf '%s' "$raw_slider" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
    [[ -n "$trimmed_slider" ]] && SLIDERS+=("$trimmed_slider")
  done
}

function slider_selector() {
  local label="$1"
  printf 'input[aria-label="%s"]' "$label"
}

function slider_slug() {
  local label="$1"
  printf '%s' "$label" |
    tr '[:upper:]' '[:lower:]' |
    sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

function ensure_visible_slider() {
  local label="$1"
  local count
  count="$(
    browser eval "(() => {
      const matches = Array.from(document.querySelectorAll('input[aria-label=\"$label\"]')).filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      });
      return matches.length;
    })()"
  )"
  count="$(printf '%s' "$count" | trim | tr -d '"')"
  [[ "$count" =~ ^[0-9]+$ && "$count" -gt 0 ]] || {
    echo "expected at least one visible slider for label '$label', got $count" >&2
    exit 1
  }
}

function list_agent_browser_chrome_pids() {
  ps -axo pid=,command= |
    awk '/\/Applications\/Google Chrome.app\/Contents\/MacOS\/Google Chrome/ && /agent-browser-chrome-/ { print $1 }'
}

function wait_for_new_browser_pid() {
  local before=("$@")
  local attempt
  local current=()
  local current_list
  local pid
  for attempt in $(seq 1 60); do
    current=()
    current_list="$(list_agent_browser_chrome_pids)"
    while IFS= read -r pid; do
      [[ -n "$pid" ]] && current+=("$pid")
    done <<< "$current_list"
    for pid in "${current[@]}"; do
      if (( ${#before[@]} == 0 )); then
        echo "$pid"
        return 0
      fi
      if ! contains_pid "$pid" "${before[@]}"; then
        echo "$pid"
        return 0
      fi
    done
    sleep 0.25
  done
  echo "failed to find new agent-browser Chrome pid" >&2
  exit 1
}

function browser_command() {
  ps -p "$BROWSER_PID" -o command= | trim
}

function browser_user_data_dir() {
  browser_command | sed -E 's/.*--user-data-dir=([^[:space:]]+).*/\1/'
}

function wait_for_gpu_pid() {
  local attempt
  local pid
  for attempt in $(seq 1 60); do
    pid="$(
      ps -axo pid=,command= |
        awk -v dir="$USER_DATA_DIR" '$0 ~ "--type=gpu-process" && $0 ~ dir { print $1; exit }'
    )"
    if [[ -n "$pid" ]]; then
      echo "$pid"
      return 0
    fi
    sleep 0.25
  done
  echo "failed to find Chrome GPU helper pid for $USER_DATA_DIR" >&2
  exit 1
}

function wait_for_editor_loaded() {
  local attempt
  local text
  for attempt in $(seq 1 120); do
    text="$(browser eval 'document.body.innerText')"
    if [[ "$text" == *"Image "* ]]; then
      return 0
    fi
    browser wait 500 >/dev/null
  done
  echo "editor did not reach loaded state" >&2
  exit 1
}

function metric_after_colon() {
  local file="$1"
  local key="$2"
  awk -F: -v key="$key" '$1 == key { gsub(/^[ \t]+/, "", $2); print $2; exit }' "$file"
}

function region_numeric_field() {
  local file="$1"
  local key="$2"
  local position="$3"
  awk -v key="$key" -v position="$position" '
    index($0, key) == 1 {
      line = substr($0, length(key) + 1);
      gsub(/^[[:space:]]+/, "", line);
      split(line, fields, /[[:space:]]+/);
      print fields[position];
      exit;
    }
  ' "$file"
}

function json_attr() {
  local key="$1"
  local value="$2"
  printf '{"key":"%s","value":{"stringValue":"%s"}}' "$(json_escape "$key")" "$(json_escape "$value")"
}

function build_resource_attributes_json() {
  local attributes=()
  attributes+=("$(json_attr "service.name" "shade-web-gpu-memory-benchmark")")
  attributes+=("$(json_attr "service.version" "1.0.0")")
  attributes+=("$(json_attr "benchmark.session" "$SESSION")")
  attributes+=("$(json_attr "benchmark.url" "$URL")")
  attributes+=("$(json_attr "benchmark.fixture" "$FIXTURE")")
  attributes+=("$(json_attr "benchmark.browser_pid" "$BROWSER_PID")")
  attributes+=("$(json_attr "benchmark.gpu_pid" "$GPU_PID")")
  attributes+=("$(json_attr "benchmark.user_data_dir" "$USER_DATA_DIR")")
  attributes+=("$(json_attr "benchmark.sliders" "$(IFS=','; echo "${SLIDERS[*]}")")")
  local joined=""
  local item
  for item in "${attributes[@]}"; do
    if [[ -n "$joined" ]]; then
      joined+=","
    fi
    joined+="$item"
  done
  printf '[%s]' "$joined"
}

function build_point_attributes_json() {
  local phase="$1"
  local slider_label="$2"
  local sweep="$3"
  local sample_file="$4"
  local attributes=()
  attributes+=("$(json_attr "benchmark.phase" "$phase")")
  attributes+=("$(json_attr "benchmark.sweep" "$sweep")")
  attributes+=("$(json_attr "benchmark.vmmap_summary_path" "$sample_file")")
  if [[ -n "$slider_label" ]]; then
    attributes+=("$(json_attr "benchmark.slider" "$slider_label")")
  fi
  local joined=""
  local item
  for item in "${attributes[@]}"; do
    if [[ -n "$joined" ]]; then
      joined+=","
    fi
    joined+="$item"
  done
  printf '[%s]' "$joined"
}

function append_metric_json() {
  local name="$1"
  local description="$2"
  local value_bytes="$3"
  local point_attributes_json="$4"
  local time_unix_nano="$5"
  local start_time_unix_nano="$6"
  local metric_json
  metric_json=$(
    printf '{"name":"%s","description":"%s","unit":"By","gauge":{"dataPoints":[{"attributes":%s,"timeUnixNano":"%s","startTimeUnixNano":"%s","asInt":"%s"}]}}' \
      "$(json_escape "$name")" \
      "$(json_escape "$description")" \
      "$point_attributes_json" \
      "$time_unix_nano" \
      "$start_time_unix_nano" \
      "$value_bytes"
  )
  METRIC_JSON_ITEMS+=("$metric_json")
}

function join_json_array() {
  local joined=""
  local item
  for item in "$@"; do
    if [[ -n "$joined" ]]; then
      joined+=","
    fi
    joined+="$item"
  done
  printf '%s' "$joined"
}

function write_otel_jsonl_sample() {
  local phase="$1"
  local slider_label="$2"
  local sweep="$3"
  local sample_file="$4"
  local physical_footprint_bytes="$5"
  local physical_footprint_peak_bytes="$6"
  local ioaccelerator_graphics_resident_bytes="$7"
  local iosurface_resident_bytes="$8"
  local owned_unmapped_graphics_resident_bytes="$9"
  local memory_tag_253_resident_bytes="${10}"
  local point_attributes_json="${11}"
  local resource_attributes_json="${12}"
  local time_unix_nano="${13}"
  local start_time_unix_nano="${14}"
  local metrics_json

  METRIC_JSON_ITEMS=()
  append_metric_json "shade.web.gpu.physical_footprint" "Chrome GPU helper physical footprint sampled from vmmap" "$physical_footprint_bytes" "$point_attributes_json" "$time_unix_nano" "$start_time_unix_nano"
  append_metric_json "shade.web.gpu.physical_footprint_peak" "Chrome GPU helper physical footprint peak sampled from vmmap" "$physical_footprint_peak_bytes" "$point_attributes_json" "$time_unix_nano" "$start_time_unix_nano"
  append_metric_json "shade.web.gpu.ioaccelerator_graphics_resident" "Resident bytes in IOAccelerator graphics region from vmmap" "$ioaccelerator_graphics_resident_bytes" "$point_attributes_json" "$time_unix_nano" "$start_time_unix_nano"
  append_metric_json "shade.web.gpu.iosurface_resident" "Resident bytes in IOSurface region from vmmap" "$iosurface_resident_bytes" "$point_attributes_json" "$time_unix_nano" "$start_time_unix_nano"
  append_metric_json "shade.web.gpu.owned_unmapped_graphics_resident" "Resident bytes in owned unmapped graphics region from vmmap" "$owned_unmapped_graphics_resident_bytes" "$point_attributes_json" "$time_unix_nano" "$start_time_unix_nano"
  append_metric_json "shade.web.gpu.memory_tag_253_resident" "Resident bytes in Memory Tag 253 region from vmmap" "$memory_tag_253_resident_bytes" "$point_attributes_json" "$time_unix_nano" "$start_time_unix_nano"
  metrics_json="$(join_json_array "${METRIC_JSON_ITEMS[@]}")"

  printf '{"resourceMetrics":[{"resource":{"attributes":%s},"scopeMetrics":[{"scope":{"name":"shade.scripts.benchmark-web-gpu-memory","version":"1.0.0"},"metrics":[%s]}]}]}\n' \
    "$resource_attributes_json" \
    "$metrics_json" \
    >>"$TELEMETRY_FILE"
}

function capture_vmmap_sample() {
  local phase="$1"
  local sweep="$2"
  local slider_label="$3"
  local sample_name
  local sample_file
  local current_footprint
  local peak_footprint
  local ioaccelerator_graphics_resident
  local iosurface_resident
  local owned_unmapped_graphics_resident
  local memory_tag_253_resident
  local current_footprint_bytes
  local peak_footprint_bytes
  local ioaccelerator_graphics_resident_bytes
  local iosurface_resident_bytes
  local owned_unmapped_graphics_resident_bytes
  local memory_tag_253_resident_bytes
  local point_attributes_json
  local resource_attributes_json
  local time_unix_nano
  local slider_name
  local stderr_file

  if [[ -n "$slider_label" ]]; then
    slider_name="$(slider_slug "$slider_label")"
    sample_name="$(printf '%03d_%s_%s_sweep-%03d' "$SAMPLE_INDEX" "$phase" "$slider_name" "$sweep")"
  else
    sample_name="$(printf '%03d_%s_sweep-%03d' "$SAMPLE_INDEX" "$phase" "$sweep")"
  fi
  sample_file="$OUT_DIR/samples/$sample_name.vmmap.txt"
  stderr_file="$sample_file.stderr"
  vmmap -summary "$GPU_PID" >"$sample_file" 2>"$stderr_file"
  [[ -s "$stderr_file" ]] || rm -f "$stderr_file"

  current_footprint="$(metric_after_colon "$sample_file" "Physical footprint")"
  peak_footprint="$(metric_after_colon "$sample_file" "Physical footprint (peak)")"
  ioaccelerator_graphics_resident="$(region_numeric_field "$sample_file" "IOAccelerator (graphics)" 2)"
  iosurface_resident="$(region_numeric_field "$sample_file" "IOSurface" 2)"
  owned_unmapped_graphics_resident="$(region_numeric_field "$sample_file" "owned unmapped (graphics)" 2)"
  memory_tag_253_resident="$(region_numeric_field "$sample_file" "Memory Tag 253" 2)"

  current_footprint_bytes="$(size_to_bytes "$current_footprint")"
  peak_footprint_bytes="$(size_to_bytes "$peak_footprint")"
  ioaccelerator_graphics_resident_bytes="$(size_to_bytes "$ioaccelerator_graphics_resident")"
  iosurface_resident_bytes="$(size_to_bytes "$iosurface_resident")"
  owned_unmapped_graphics_resident_bytes="$(size_to_bytes "$owned_unmapped_graphics_resident")"
  memory_tag_253_resident_bytes="$(size_to_bytes "$memory_tag_253_resident")"
  point_attributes_json="$(build_point_attributes_json "$phase" "$slider_label" "$sweep" "$sample_file")"
  resource_attributes_json="$(build_resource_attributes_json)"
  time_unix_nano="$(sample_time_unix_nano)"

  write_otel_jsonl_sample \
    "$phase" \
    "$slider_label" \
    "$sweep" \
    "$sample_file" \
    "$current_footprint_bytes" \
    "$peak_footprint_bytes" \
    "$ioaccelerator_graphics_resident_bytes" \
    "$iosurface_resident_bytes" \
    "$owned_unmapped_graphics_resident_bytes" \
    "$memory_tag_253_resident_bytes" \
    "$point_attributes_json" \
    "$resource_attributes_json" \
    "$time_unix_nano" \
    "$START_TIME_UNIX_NANO"

  SAMPLE_INDEX=$((SAMPLE_INDEX + 1))
}

function slider_box_value() {
  local key="$1"
  awk -F: -v key="$key" '
    $1 == key {
      gsub(/^[ \t]+/, "", $2);
      gsub(/[^0-9.-]/, "", $2);
      print int($2);
      exit;
    }
    $1 ~ "\"" key "\"" {
      gsub(/^[ \t]+/, "", $2);
      gsub(/[^0-9.-]/, "", $2);
      print int($2);
      exit;
    }
  '
}

function drag_segment() {
  local from_x="$1"
  local to_x="$2"
  local y="$3"
  local step
  local x
  for step in $(seq 1 "$DRAG_STEPS"); do
    x=$((from_x + (to_x - from_x) * step / DRAG_STEPS))
    browser mouse move "$x" "$y" >/dev/null
  done
}

function slider_box() {
  local label="$1"
  browser eval "(() => {
    const matches = Array.from(document.querySelectorAll('input[aria-label=\"$label\"]')).filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    if (matches.length === 0) {
      throw new Error('visible slider not found: $label');
    }
    const rect = matches[0].getBoundingClientRect();
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  })()"
}

function drag_slider_sweeps() {
  local label="$1"
  local box_output
  local left_x
  local top_y
  local width
  local height
  local right_x
  local center_y
  local sweep

  ensure_visible_slider "$label"
  box_output="$(slider_box "$label")"
  left_x="$(printf '%s\n' "$box_output" | slider_box_value x)"
  top_y="$(printf '%s\n' "$box_output" | slider_box_value y)"
  width="$(printf '%s\n' "$box_output" | slider_box_value width)"
  height="$(printf '%s\n' "$box_output" | slider_box_value height)"

  right_x=$((left_x + width - 8))
  left_x=$((left_x + 8))
  center_y=$((top_y + height / 2))

  browser mouse move "$left_x" "$center_y" >/dev/null
  browser mouse down left >/dev/null

  for sweep in $(seq 1 "$SWEEPS_PER_SLIDER"); do
    drag_segment "$left_x" "$right_x" "$center_y"
    drag_segment "$right_x" "$left_x" "$center_y"
    TOTAL_SWEEPS=$((TOTAL_SWEEPS + 1))
    if (( TOTAL_SWEEPS % SAMPLE_EVERY == 0 )); then
      capture_vmmap_sample "during_drag" "$TOTAL_SWEEPS" "$label"
    fi
  done

  browser mouse up left >/dev/null
  browser wait "$WAIT_AFTER_SLIDER_MS" >/dev/null
  capture_vmmap_sample "after_slider" "$TOTAL_SWEEPS" "$label"
}

function cleanup() {
  set +e
  agent-browser --session "$SESSION" close >/dev/null 2>&1
}

parse_args "$@"

require_command agent-browser
require_command vmmap
require_command ps

[[ "$OSTYPE" == darwin* ]] || {
  echo "this benchmark requires macOS for vmmap" >&2
  exit 1
}
[[ -f "$FIXTURE" ]] || {
  echo "fixture not found: $FIXTURE" >&2
  exit 1
}
[[ "$SWEEPS_PER_SLIDER" =~ ^[0-9]+$ && "$SWEEPS_PER_SLIDER" -gt 0 ]] || {
  echo "--sweeps-per-slider must be positive integer" >&2
  exit 1
}
[[ "$SAMPLE_EVERY" =~ ^[0-9]+$ && "$SAMPLE_EVERY" -gt 0 ]] || {
  echo "--sample-every must be positive integer" >&2
  exit 1
}
[[ "$DRAG_STEPS" =~ ^[0-9]+$ && "$DRAG_STEPS" -gt 0 ]] || {
  echo "--drag-steps must be positive integer" >&2
  exit 1
}
[[ "$WAIT_AFTER_SLIDER_MS" =~ ^[0-9]+$ && "$WAIT_AFTER_SLIDER_MS" -ge 0 ]] || {
  echo "--wait-after-slider-ms must be non-negative integer" >&2
  exit 1
}

build_slider_list
(( ${#SLIDERS[@]} > 0 )) || {
  echo "at least one slider label is required" >&2
  exit 1
}
START_TIME_UNIX_NANO="$(sample_time_unix_nano)"

mkdir -p "$OUT_DIR/samples"
trap cleanup EXIT
TELEMETRY_FILE="$OUT_DIR/telemetry.jsonl"

cat >"$OUT_DIR/metadata.txt" <<EOF
session=$SESSION
url=$URL
fixture=$FIXTURE
sweeps_per_slider=$SWEEPS_PER_SLIDER
sample_every=$SAMPLE_EVERY
wait_after_load_ms=$WAIT_AFTER_LOAD_MS
wait_after_slider_ms=$WAIT_AFTER_SLIDER_MS
drag_steps=$DRAG_STEPS
sliders=$(IFS=','; echo "${SLIDERS[*]}")
started_at=$(date '+%Y-%m-%dT%H:%M:%S%z')
start_time_unix_nano=$START_TIME_UNIX_NANO
EOF
echo "telemetry_file=$TELEMETRY_FILE" >>"$OUT_DIR/metadata.txt"

EXISTING_BROWSER_PIDS=()
while IFS= read -r BROWSER_PID_ENTRY; do
  [[ -n "$BROWSER_PID_ENTRY" ]] && EXISTING_BROWSER_PIDS+=("$BROWSER_PID_ENTRY")
done <<< "$(list_agent_browser_chrome_pids)"

agent-browser --headed true --session "$SESSION" open "$URL" >/dev/null

if (( ${#EXISTING_BROWSER_PIDS[@]} == 0 )); then
  BROWSER_PID="$(wait_for_new_browser_pid)"
else
  BROWSER_PID="$(wait_for_new_browser_pid "${EXISTING_BROWSER_PIDS[@]}")"
fi
USER_DATA_DIR="$(browser_user_data_dir)"
GPU_PID="$(wait_for_gpu_pid)"

echo "browser_pid=$BROWSER_PID" >>"$OUT_DIR/metadata.txt"
echo "gpu_pid=$GPU_PID" >>"$OUT_DIR/metadata.txt"
echo "user_data_dir=$USER_DATA_DIR" >>"$OUT_DIR/metadata.txt"

capture_vmmap_sample "after_browser_open" 0 ""

browser upload 'input.hidden' "$FIXTURE" >/dev/null
browser wait "$WAIT_AFTER_LOAD_MS" >/dev/null
wait_for_editor_loaded

capture_vmmap_sample "after_image_load" 0 ""

for SLIDER_LABEL in "${SLIDERS[@]}"; do
  drag_slider_sweeps "$SLIDER_LABEL"
done

browser wait 1000 >/dev/null

capture_vmmap_sample "after_drag_release" "$TOTAL_SWEEPS" ""

cat <<EOF
benchmark complete
  out_dir: $OUT_DIR
  browser_pid: $BROWSER_PID
  gpu_pid: $GPU_PID
  sliders: $(IFS=','; echo "${SLIDERS[*]}")
  sweeps_per_slider: $SWEEPS_PER_SLIDER
  total_sweeps: $TOTAL_SWEEPS
  telemetry_jsonl: $TELEMETRY_FILE
EOF
