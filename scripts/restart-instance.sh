#!/usr/bin/env bash
# restart-instance.sh — restart NyxHive instances cleanly
#
# Usage:
#   ./scripts/restart-instance.sh nyxlabs          # restart one
#   ./scripts/restart-instance.sh nyxlabs nyxai      # restart multiple
#   ./scripts/restart-instance.sh all               # restart all (nyxai last)
#   ./scripts/restart-instance.sh --self            # restart nyxai (careful!)
#
# Brain override (temporary):
#   BRAIN=codex ./scripts/restart-instance.sh nyxlabs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${NYXHIVE_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ASTRA_TRADING_DIR="${ASTRA_TRADING_DIR:-$HOME/dev/personal/astra-trading}"
ASTRA_TRADING_CONFIG="${ASTRA_TRADING_CONFIG:-$ASTRA_TRADING_DIR/.nyxhive/config.toml}"
RUN_DIR="$HOME/.nyxhive/run"
mkdir -p "$RUN_DIR"
ORIGINAL_ARGS=("$@")

declare -A INSTANCE_DIR=(
  [nyxai]="$REPO_DIR"
  [nyxlabs]="$REPO_DIR"
  [astra-trading]="$REPO_DIR"
)

declare -A INSTANCE_CMD=(
  [nyxai]="bun run src/cli/index.ts start NyxAI"
  [nyxlabs]="bun run src/cli/index.ts start NyxLabs"
  [astra-trading]="bun run src/cli/index.ts start --config \"$ASTRA_TRADING_CONFIG\""
)

declare -A INSTANCE_PORT=(
  [nyxai]=3779
  [nyxlabs]=3778
  [astra-trading]=3782
)

ALL_INSTANCES=(astra-trading nyxlabs nyxai)  # nyxai last since it hosts the agent

# ── Helpers ───────────────────────────────────────────────────────────

red()    { printf "\033[0;31m%s\033[0m\n" "$*"; }
green()  { printf "\033[0;32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[0;33m%s\033[0m\n" "$*"; }
dim()    { printf "\033[0;90m%s\033[0m\n" "$*"; }

ensure_restart_id() {
  if [ -z "${NYXHIVE_RESTART_ID:-}" ]; then
    export NYXHIVE_RESTART_ID="restart-$(date +%s)-$$-${RANDOM:-0}"
  fi
}

record_restart_provenance() {
  local action=$1
  local name=$2
  local log_file=${3:-}
  local session_name=${4:-}

  ensure_restart_id
  NYXHIVE_RESTART_CALLER_PID="$$" \
  NYXHIVE_RESTART_PARENT_PID="$PPID" \
  NYXHIVE_RESTART_CWD="$(pwd)" \
  NYXHIVE_RESTART_LOG_FILE="$log_file" \
  NYXHIVE_RESTART_SESSION_NAME="$session_name" \
    bun "$SCRIPT_DIR/record-restart-provenance.ts" "$action" "$name" "${ORIGINAL_ARGS[@]}" 2>/dev/null || true
}

wait_for_port() {
  local port=$1 timeout=${2:-20} elapsed=0
  while ! lsof -iTCP:"$port" -sTCP:LISTEN &>/dev/null; do
    sleep 1
    elapsed=$((elapsed + 1))
    [ $elapsed -ge $timeout ] && return 1
  done
  return 0
}

wait_for_port_down() {
  local port=$1 timeout=${2:-15} elapsed=0
  while lsof -iTCP:"$port" -sTCP:LISTEN &>/dev/null; do
    sleep 1
    elapsed=$((elapsed + 1))
    [ $elapsed -ge $timeout ] && return 1
  done
  return 0
}

# Kill everything related to a port — the port holder AND its entire process group.
# This clears orphaned bun/node/claude child processes that survive a plain kill.
kill_port_processes() {
  local port=$1

  # Get all PIDs listening on the port (can be multiple)
  local pids
  pids=$(lsof -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  [ -z "$pids" ] && return 0

  for pid in $pids; do
    # Get the process group ID and kill the whole group
    local pgid
    pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    if [ -n "$pgid" ] && [ "$pgid" != "0" ]; then
      dim "  Killing process group $pgid (from pid $pid on port $port)..."
      kill -- -"$pgid" 2>/dev/null || true
    else
      dim "  Killing pid $pid on port $port..."
      kill "$pid" 2>/dev/null || true
    fi
  done

  # Give SIGTERM a moment to work
  sleep 1

  # Force-kill anything still on the port
  pids=$(lsof -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$pids" ]; then
    yellow "  Force-killing remaining processes on port $port..."
    for pid in $pids; do
      kill -9 "$pid" 2>/dev/null || true
    done
  fi
}

restart_instance() {
  local name=$1
  local dir="${INSTANCE_DIR[$name]}"
  local cmd="${INSTANCE_CMD[$name]}"
  local port="${INSTANCE_PORT[$name]}"
  local stop_file="${RUN_DIR}/stop-${name}"

  [ -n "${BRAIN:-}" ] && cmd="$cmd --brain $BRAIN"
  record_restart_provenance "execute" "$name"

  echo ""
  echo "━━━ Restarting $name ━━━"

  # Step 1: Drop stop file FIRST so the loop wrapper knows not to auto-restart
  touch "$stop_file"
  dim "  Stop file set — loop wrapper will not auto-restart"

  # Step 2: Send Ctrl+C to the tmux session (graceful shutdown signal)
  if tmux has-session -t "=$name" 2>/dev/null; then
    yellow "  Sending stop signal..."
    tmux send-keys -t "=$name" C-c
    sleep 1
  else
    yellow "  No tmux session '$name' — will create one"
  fi

  # Step 3: Kill the whole process group if port is still held
  if lsof -iTCP:"$port" -sTCP:LISTEN &>/dev/null; then
    yellow "  Port $port still held, killing process group..."
    kill_port_processes "$port"
  fi

  # Step 4: Wait for port to fully clear
  if ! wait_for_port_down "$port" 10; then
    red "  Port $port still held after kill attempt — something is very stuck"
    red "  Manual cleanup needed: lsof -iTCP:$port -sTCP:LISTEN"
    rm -f "$stop_file"
    return 1
  fi

  green "  Port $port is free"

  # Step 5: Brief settle time
  sleep 1

  # Step 6: Remove stop file and start via loop wrapper
  rm -f "$stop_file"

  if tmux has-session -t "=$name" 2>/dev/null; then
    dim "  Recreating tmux session '$name'..."
    tmux kill-session -t "=$name" 2>/dev/null || true
    sleep 1
  else
    yellow "  Creating tmux session '$name'..."
  fi
  tmux new-session -d -s "$name" -c "$dir" "$SCRIPT_DIR/run-instance.sh $name"

  # Step 7: Wait for the instance to come up
  if wait_for_port "$port" 30; then
    green "  $name is up on port $port ✓"
  else
    red "  $name failed to come up within 30s — check: tmux attach -t $name"
    return 1
  fi
}

# ── Main ──────────────────────────────────────────────────────────────

if [ $# -eq 0 ]; then
  echo "Usage: $0 <instance...> | all | --self"
  echo ""
  echo "Instances: nyxai, nyxlabs, astra-trading"
  echo ""
  echo "  $0 astra-trading     # restart Astra"
  echo "  $0 nyxlabs           # restart nyxlabs"
  echo "  $0 nyxlabs nyxai     # restart both"
  echo "  $0 all               # restart all (nyxai last)"
  echo "  $0 --self            # restart nyxai (disconnects agent)"
  echo ""
  echo "Brain override (temporary):"
  echo "  BRAIN=codex $0 nyxlabs"
  exit 1
fi

targets=()

if [ "$1" = "all" ]; then
  targets=("${ALL_INSTANCES[@]}")
elif [ "$1" = "--self" ]; then
  yellow "WARNING: Restarting nyxai will disconnect any running Claude agent session."
  echo ""
  log_file="${RUN_DIR}/restart-nyxai-$(date +%Y%m%d-%H%M%S).log"
  session_name="self-restart-nyxai-$(date +%s)"
  ensure_restart_id
  record_restart_provenance "schedule" "nyxai" "$log_file" "$session_name"
  printf -v restart_id_q "%q" "$NYXHIVE_RESTART_ID"
  printf -v source_q "%q" "self-helper"
  printf -v reason_q "%q" "${NYXHIVE_RESTART_REASON:-self restart}"
  printf -v script_q "%q" "$SCRIPT_DIR/restart-instance.sh"
  printf -v log_file_q "%q" "$log_file"
  yellow "Scheduling detached nyxai restart helper."
  dim "  log: $log_file"
  tmux new-session -d -s "$session_name" -c "${INSTANCE_DIR[nyxai]}" \
    "sleep 1; NYXHIVE_RESTART_ID=$restart_id_q NYXHIVE_RESTART_SOURCE=$source_q NYXHIVE_RESTART_REASON=$reason_q $script_q nyxai > $log_file_q 2>&1"
  green "Detached restart helper started ($session_name)."
  exit 0
else
  targets=("$@")
fi

for name in "${targets[@]}"; do
  if [ -z "${INSTANCE_DIR[$name]+x}" ]; then
    red "Unknown instance: $name"
    red "Valid: nyxai, nyxlabs, astra-trading"
    exit 1
  fi
done

failed=0
for name in "${targets[@]}"; do
  if [ "$name" = "nyxai" ] && [ ${#targets[@]} -gt 1 ]; then
    yellow ""
    yellow "Restarting nyxai last (hosts the agent)..."
  fi
  restart_instance "$name" || failed=$((failed + 1))
done

echo ""
if [ $failed -eq 0 ]; then
  green "All done."
else
  red "$failed instance(s) failed to restart."
  exit 1
fi
