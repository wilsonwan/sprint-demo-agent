#!/usr/bin/env bash
# Restarts the agent in the tmux session "demo-agent": stops it, waits until it has exited (only
# one process may own the database), then starts it again with run.sh.
cd "$(dirname "$0")"
pattern="src/main.ts --port ${PORT:-4400}"
pkill -INT -f "$pattern"
for _ in $(seq 1 60); do pgrep -f "$pattern" >/dev/null || break; sleep 0.5; done
if pgrep -f "$pattern" >/dev/null; then echo "the agent didn't stop within 30 s" >&2; exit 1; fi
tmux has-session -t demo-agent 2>/dev/null || tmux new-session -d -s demo-agent -c "$PWD"
tmux send-keys -t demo-agent "${RUN:-./run.sh}" Enter
sleep 8
tail -4 data/agent.log
