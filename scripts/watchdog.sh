#!/usr/bin/env bash
# watchdog.sh — safety net for NyxHive instances
#
# Checks if each instance's tmux session is alive and its port is listening.
# If a session exists but the port is down, it restarts the loop wrapper.
# If the session doesn't exist at all, it creates it.
#
# Designed to run as a cron job every 2 minutes:
#   */2 * * * * /home/user/dev/nyxhive/scripts/watchdog.sh >> /tmp/nyxhive-watchdog.log 2>&1

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_SCRIPT="$SCRIPT_DIR/run-instance.sh"

declare -A INSTANCE_DIR=(
  [nyxai]="/home/user/dev/nyxhive"
  [nyxlabs]="/home/user/dev/nyxhive"
)

declare -A INSTANCE_PORT=(
  [nyxai]=3779
  [nyxlabs]=3778
)

INSTANCES=(nyxai nyxlabs)

ts() { date "+%Y-%m-%d %H:%M:%S"; }

for name in "${INSTANCES[@]}"; do
  port="${INSTANCE_PORT[$name]}"
  stop_file="$HOME/.nyxhive/run/stop-${name}"

  # Skip if intentionally stopped
  if [ -f "$stop_file" ]; then
    continue
  fi

  # Check if port is listening
  if lsof -iTCP:"$port" -sTCP:LISTEN &>/dev/null; then
    continue  # all good
  fi

  # Port is down — check if tmux session exists
  if tmux has-session -t "$name" 2>/dev/null; then
    # Session exists but port is down. The loop wrapper should handle this.
    # Only intervene if the port has been down for a while (check a marker file)
    marker="$HOME/.nyxhive/run/down-${name}"

    if [ -f "$marker" ]; then
      # Second check failed — port has been down for at least one cron interval
      down_since=$(cat "$marker")
      echo "[$(ts)] WATCHDOG: $name port $port still down since $down_since. Restarting tmux session."

      # Kill the session and recreate with the loop wrapper
      tmux kill-session -t "$name" 2>/dev/null || true
      sleep 1
      tmux new-session -d -s "$name" -c "${INSTANCE_DIR[$name]}" "$RUN_SCRIPT $name"

      rm -f "$marker"
    else
      # First time seeing it down — mark it, give the loop wrapper a chance
      echo "$(ts)" > "$marker"
      echo "[$(ts)] WATCHDOG: $name port $port is down. Marked. Will restart on next check if still down."
    fi
  else
    # No tmux session at all — create it
    echo "[$(ts)] WATCHDOG: tmux session '$name' missing. Creating with loop wrapper."
    tmux new-session -d -s "$name" -c "${INSTANCE_DIR[$name]}" "$RUN_SCRIPT $name"
  fi
done
