#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
project_root=$(cd "${script_dir}/.." && pwd)

real_cargo_tauri=$(command -v cargo-tauri)
if [[ -z "${real_cargo_tauri}" ]]; then
  echo "cargo-tauri was not found in PATH" >&2
  exit 1
fi

if [[ $# -eq 3 && "$1" == "ios" && "$2" == "run" ]]; then
  case "$3" in
    -h|--help|-V|--version)
      exec "${real_cargo_tauri}" "$@"
      ;;
  esac
fi

if [[ $# -lt 2 || "$1" != "ios" || "$2" != "run" ]]; then
  exec "${real_cargo_tauri}" "$@"
fi

cd "${project_root}"

shift 2

build_args=()
runner_args=()
device=""
debug_build=0

while (($#)); do
  case "$1" in
    --)
      shift
      runner_args=("$@")
      break
      ;;
    -r|--release)
      debug_build=0
      shift
      ;;
    -v|--verbose|--ignore-version-mismatches)
      build_args+=("$1")
      shift
      ;;
    -f|--features|-c|--config)
      if (($# < 2)); then
        echo "missing value for $1" >&2
        exit 1
      fi
      build_args+=("$1" "$2")
      shift 2
      ;;
    --additional-watch-folders|--no-watch)
      echo "$1 is not supported by the project-local ios run workaround" >&2
      exit 1
      ;;
    -*)
      echo "unsupported cargo tauri ios run option: $1" >&2
      exit 1
      ;;
    *)
      if [[ -n "${device}" ]]; then
        echo "multiple device arguments are not supported" >&2
        exit 1
      fi
      device="$1"
      shift
      ;;
  esac
done

cmd=("${real_cargo_tauri}" "ios" "build")
if ((debug_build)); then
  cmd+=("--debug")
fi
if ((${#build_args[@]})); then
  cmd+=("${build_args[@]}")
fi
"${cmd[@]}"

app_path=$(find gen/apple/build -type d -path '*_iOS.xcarchive/Products/Applications/*.app' | sort | tail -n 1)
if [[ -z "${app_path}" ]]; then
  echo "failed to find the archived iOS app bundle" >&2
  exit 1
fi

bundle_id=$(plutil -extract CFBundleIdentifier raw -o - "${app_path}/Info.plist")
if [[ -z "${bundle_id}" ]]; then
  echo "failed to read CFBundleIdentifier from ${app_path}/Info.plist" >&2
  exit 1
fi

if [[ -z "${device}" ]]; then
  device=$(xcrun xcdevice list | /usr/bin/python3 -c '
import json
import sys

devices = json.load(sys.stdin)
physical_devices = [
    device
    for device in devices
    if not device.get("simulator")
    and device.get("platform") == "com.apple.platform.iphoneos"
    and device.get("available")
]
if not physical_devices:
    raise SystemExit("no available connected iOS device found")
if len(physical_devices) > 1:
    raise SystemExit(
        "multiple connected iOS devices found; pass the target device explicitly"
    )
print(physical_devices[0]["identifier"])
')
fi

echo "Installing ${app_path} on ${device}..."
xcrun devicectl device install app --device "${device}" "${app_path}"

echo "Launching ${bundle_id} on ${device}..."
launch_cmd=(xcrun devicectl device process launch --device "${device}" --terminate-existing "${bundle_id}")
if ((${#runner_args[@]})); then
  launch_cmd+=("${runner_args[@]}")
fi
exec "${launch_cmd[@]}"
