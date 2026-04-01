#!/usr/bin/env bash
# Stop llama-server started by llama-ci-local-server-start.sh (best-effort).
set -euo pipefail

LLAMA_CI_ROOT="${LLAMA_CI_ROOT:?LLAMA_CI_ROOT required}"
PID_FILE="$LLAMA_CI_ROOT/llama-server.pid"

if [[ ! -f "$PID_FILE" ]]; then
	exit 0
fi

pid="$(cat "$PID_FILE" 2>/dev/null || true)"
if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
	kill "$pid" 2>/dev/null || true
	sleep 1
fi
rm -f "$PID_FILE"
