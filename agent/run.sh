#!/usr/bin/env bash
# Runs the agent in the foreground: Node with the tsx loader, no npx wrapper and no pipe, so
# Ctrl+C reaches only the agent and it closes cleanly (a crash would count toward the restart
# limit of every demo waiting at a gate). Output also goes to data/agent.log.
cd "$(dirname "$0")"
mkdir -p data
# Host settings (see .env.example), if any.
if [ -f .env ]; then set -a; . ./.env; set +a; fi
export NODE_NO_WARNINGS=1
exec > >(tee -a data/agent.log) 2>&1
exec node --import tsx src/main.ts --port "${PORT:-4400}" "$@"
