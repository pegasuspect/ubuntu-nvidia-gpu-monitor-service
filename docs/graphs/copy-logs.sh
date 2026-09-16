#!/bin/bash
# Copies daily GPU telemetry CSVs into docs/graphs/data/ and builds manifest.json
# Usage: ./copy-logs.sh [source-dir]
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${1:-/var/log/gpu-monitor}"
DATA_DIR="$SCRIPT_DIR/data"
MANIFEST="$DATA_DIR/manifest.json"

if [[ ! -d "$SRC" || ! -r "$SRC" ]]; then
  echo "error: cannot read log directory: $SRC" >&2
  echo "hint:  pass a source path:  ./copy-logs.sh /path/to/gpu-logs" >&2
  echo "hint:  if the system log dir needs root:  sudo ./copy-logs.sh" >&2
  exit 1
fi

shopt -s nullglob
files=("$SRC"/gpu-test-*.csv)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "error: no gpu-test-*.csv files found in $SRC" >&2
  exit 1
fi

mkdir -p "$DATA_DIR"

copied=0
for f in "${files[@]}"; do
  if [[ ! -f "$DATA_DIR/$(basename "$f")" ]] || [[ "$f" -nt "$DATA_DIR/$(basename "$f")" ]]; then
    cp -p "$f" "$DATA_DIR/"
    copied=$((copied + 1))
  fi
done

names=()
for f in "$DATA_DIR"/gpu-test-*.csv; do
  names+=("$(basename "$f")")
done
sorted=($(printf '%s\n' "${names[@]}" | sort))

{
  echo '['
  for i in "${!sorted[@]}"; do
    printf '  "%s"' "${sorted[$i]}"
    if [[ $i -lt $((${#sorted[@]} - 1)) ]]; then
      echo ','
    else
      echo ''
    fi
  done
  echo ']'
} > "$MANIFEST"

total=${#sorted[@]}
echo "Copied $copied new/updated file(s); $total CSV(s) available in $DATA_DIR"