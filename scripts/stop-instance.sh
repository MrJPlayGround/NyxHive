#!/usr/bin/env bash
# stop-instance.sh — cleanly stop a NyxHive instance and its restart loop
#
# Usage:
#   ./scripts/stop-instance.sh nyxlabs          # stop one
#   ./scripts/stop-instance.sh nyxlabs nyxai     # stop multiple
#   ./scripts/stop-instance.sh all               # stop all

set -euo pipefail

RUN_DIR="$HOME/.nyxhive/run"
mkdir -p "$RUN_DIR"

declare -A INSTANCE_PORT=(
  [nyxai]=3779
  [nyxlabs]=3778
  [astra-trading]=3782
)

ALL_INSTANCES=(astra-trading nyxlabs nyxai)

red()    { printf "\033[0;31m%s\033[0m\n" "$*"; }
green()  { printf "\033[0;32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[0;33m%s\033[0m\n" "$*"; }
dim()    { printf "\033[0;90m%s\033[0m\n" "$*"; }

kill_port_processes() {
  local port=$1
  local pids
  pids=$(lsof -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  [ -z "$pids" ] && return 0

  for pid in $pids; do
    local pgid
    pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    if [ -n "$pgid" ] && [ "$pgid" != "0" ]; then
      dim "  Killing process group $pgid (from pid $pid)..."
      kill -- -"$pgid" 2>/dev/null || true
    else
      kill "$pid" 2>/dev/null || true
    fi
  done

  sleep 1

  pids=$(lsof -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$pids" ]; then
    yellow "  Force-killing remaining processes on port $port..."
    for pid in $pids; do
      kill -9 "$pid" 2>/dev/null || true
    done
  fi
}

stop_instance() {
  local name=$1
  local port="${INSTANCE_PORT[$name]}"
  local stop_file="${RUN_DIR}/stop-${name}"

  echo ""
  echo "━━━ Stopping $name ━━━"

  # Drop stop file FIRST so loop wrapper won't auto-restart
  touch "$stop_file"
  green "  Stop file created"

  if ! tmux has-session -t "=$name" 2>/dev/null; then
    yellow "  No tmux session '$name'. Already stopped."
    return 0
  fi

  # Graceful stop signal
  tmux send-keys -t "=$name" C-c
  yellow "  Stop signal sent..."
  sleep 1

  # Kill process group if port is still held
  if lsof -iTCP:"$port" -sTCP:LISTEN &>/dev/null; then
    kill_port_processes "$port"
  fi

  # Wait for port to clear
  local elapsed=0
  while lsof -iTCP:"$port" -sTCP:LISTEN &>/dev/null; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ $elapsed -ge 10 ]; then
      red "  Port $port still held after 10s — may need manual cleanup"
      break
    fi
  done

  green "  $name stopped."
  dim "  To restart: ./scripts/restart-instance.sh $name"
}

# ── Main ──────────────────────────────────────────────────────────────

if [ $# -eq 0 ]; then
  echo "Usage: $0 <instance...> | all"
  echo ""
  echo "Instances: nyxai, nyxlabs, astra-trading"
  echo ""
  echo "  $0 nyxlabs           # stop nyxlabs"
  echo "  $0 all               # stop everything"
  exit 1
fi

targets=()

if [ "$1" = "all" ]; then
  targets=("${ALL_INSTANCES[@]}")
else
  targets=("$@")
fi

for name in "${targets[@]}"; do
  if [ -z "${INSTANCE_PORT[$name]+x}" ]; then
    red "Unknown instance: $name"
    red "Valid: nyxai, nyxlabs, astra-trading"
    exit 1
  fi
  stop_instance "$name"
done

echo ""
green "Done. Stop files will be removed on next restart."
