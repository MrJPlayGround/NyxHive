#!/usr/bin/env bash
# run-instance.sh — run a NyxHive instance in a restart loop
#
# Designed to be the entrypoint in tmux sessions. If the process exits
# (crash, OOM, manual Ctrl+C), it automatically restarts after a short delay.
#
# Usage (in tmux):
#   ./scripts/run-instance.sh nyxai
#   ./scripts/run-instance.sh nyxlabs
#   ./scripts/run-instance.sh astra-trading
#
# To stop the loop entirely:
#   touch /tmp/nyxhive-stop-<instance>    # then Ctrl+C or kill the process
#   # loop will exit cleanly instead of restarting
#   # remove the stop file when you want auto-restart again

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${NYXHIVE_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ASTRA_TRADING_DIR="${ASTRA_TRADING_DIR:-$HOME/dev/personal/astra-trading}"
ASTRA_TRADING_CONFIG="${ASTRA_TRADING_CONFIG:-$ASTRA_TRADING_DIR/.nyxhive/config.toml}"

# ── Instance definitions ──────────────────────────────────────────────
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

declare -A INSTANCE_PID_FILE=(
  [nyxai]="$REPO_DIR/.nyxhive/data/nyxhive.pid"
  [nyxlabs]="$HOME/.nyxhive/instances/NyxLabs/data/nyxhive.pid"
  [astra-trading]="$ASTRA_TRADING_DIR/.nyxhive/data/nyxhive.pid"
)

declare -A INSTANCE_PORT=(
  [nyxai]=3779
  [nyxlabs]=3778
  [astra-trading]=3782
)

# ── Helpers ───────────────────────────────────────────────────────────
red()    { printf "\033[0;31m%s\033[0m\n" "$*"; }
green()  { printf "\033[0;32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[0;33m%s\033[0m\n" "$*"; }
dim()    { printf "\033[0;90m%s\033[0m\n" "$*"; }

ts() { date "+%Y-%m-%d %H:%M:%S"; }

already_running_pid() {
  local pid_file="${INSTANCE_PID_FILE[$INSTANCE]:-}"
  [ -n "$pid_file" ] || return 1
  [ -f "$pid_file" ] || return 1

  local pid
  pid=$(cat "$pid_file" 2>/dev/null || true)
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  printf "%s" "$pid"
}

listening_pid() {
  local port="${INSTANCE_PORT[$INSTANCE]:-}"
  [ -n "$port" ] || return 1

  local pid
  pid=$(lsof -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  printf "%s" "$pid"
}

# ── Main ──────────────────────────────────────────────────────────────
INSTANCE="${1:-}"

if [ -z "$INSTANCE" ] || [ -z "${INSTANCE_DIR[$INSTANCE]+x}" ]; then
  echo "Usage: $0 <nyxai|nyxlabs|astra-trading>"
  exit 1
fi

DIR="${INSTANCE_DIR[$INSTANCE]}"
CMD="${INSTANCE_CMD[$INSTANCE]}"
RUN_DIR="$HOME/.nyxhive/run"
mkdir -p "$RUN_DIR"
STOP_FILE="${RUN_DIR}/stop-${INSTANCE}"
RESTART_DELAY=5
MAX_RAPID_RESTARTS=5
RAPID_WINDOW=60  # seconds

# Clean up any stale stop file
rm -f "$STOP_FILE"

if pid=$(already_running_pid); then
  yellow "[$(ts)] $INSTANCE already running (PID $pid). Exiting restart loop."
  exit 0
fi

if pid=$(listening_pid); then
  pid_file="${INSTANCE_PID_FILE[$INSTANCE]:-}"
  if [ -n "$pid_file" ]; then
    mkdir -p "$(dirname "$pid_file")"
    printf "%s" "$pid" > "$pid_file"
  fi
  yellow "[$(ts)] $INSTANCE port already active (PID $pid). Exiting restart loop."
  exit 0
fi

rapid_count=0
window_start=$(date +%s)

green "[$(ts)] Starting $INSTANCE restart loop"
dim "  dir: $DIR"
dim "  cmd: $CMD"
dim "  stop: ./scripts/stop-instance.sh $INSTANCE"
echo ""

while true; do
  # Check for stop file before starting
  if [ -f "$STOP_FILE" ]; then
    yellow "[$(ts)] Stop file found ($STOP_FILE). Exiting loop."
    rm -f "$STOP_FILE"
    exit 0
  fi

  # Track rapid restarts (crash loop protection)
  now=$(date +%s)
  if (( now - window_start > RAPID_WINDOW )); then
    rapid_count=0
    window_start=$now
  fi
  rapid_count=$((rapid_count + 1))

  if (( rapid_count > MAX_RAPID_RESTARTS )); then
    red "[$(ts)] $INSTANCE crashed $MAX_RAPID_RESTARTS times in ${RAPID_WINDOW}s. Backing off 60s..."
    sleep 60
    rapid_count=0
    window_start=$(date +%s)
  fi

  green "[$(ts)] Starting $INSTANCE..."
  cd "$DIR" && eval "$CMD"
  EXIT_CODE=$?

  # Check stop file after exit too
  if [ -f "$STOP_FILE" ]; then
    yellow "[$(ts)] Stop file found. Exiting loop."
    rm -f "$STOP_FILE"
    exit 0
  fi

  if [ $EXIT_CODE -eq 0 ]; then
    yellow "[$(ts)] $INSTANCE exited cleanly (code 0). Restarting in ${RESTART_DELAY}s..."
  else
    red "[$(ts)] $INSTANCE crashed (code $EXIT_CODE). Restarting in ${RESTART_DELAY}s..."
  fi

  sleep "$RESTART_DELAY"
done
