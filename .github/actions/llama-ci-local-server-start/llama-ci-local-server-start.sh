#!/usr/bin/env bash
# Start llama.cpp llama-server on localhost for CI (OpenAI-compatible /v1).
# Expects: LLAMA_RELEASE (e.g. b8575), MODEL_URL (https .gguf), LLAMA_CI_ROOT, optional LLAMA_PORT (default 8080).
# Writes GITHUB_OUTPUT: compat_url, started=true on success.
set -euo pipefail

LLAMA_RELEASE="${LLAMA_RELEASE:?LLAMA_RELEASE required}"
MODEL_URL="${MODEL_URL:?MODEL_URL required}"
LLAMA_CI_ROOT="${LLAMA_CI_ROOT:?LLAMA_CI_ROOT required}"
LLAMA_PORT="${LLAMA_PORT:-8080}"
EXTRA_FLAGS="${EXTRA_FLAGS:-}"

if [[ ! "$MODEL_URL" =~ ^https:// ]]; then
	echo "::error::MODEL_URL must be an https URL"
	exit 1
fi

ROOT="$LLAMA_CI_ROOT"
BIN_DIR="$ROOT/llama-${LLAMA_RELEASE}"
ARCHIVE="$ROOT/llama-${LLAMA_RELEASE}-bin-ubuntu-x64.tar.gz"
MODEL_FILE="$ROOT/model/model.gguf"
LOG_FILE="$ROOT/llama-server.log"
PID_FILE="$ROOT/llama-server.pid"

mkdir -p "$ROOT/model"

if [[ ! -x "$BIN_DIR/llama-server" ]]; then
	rm -rf "$BIN_DIR"
	echo "Downloading llama.cpp ${LLAMA_RELEASE} (ubuntu-x64)…"
	curl -fsSL -o "$ARCHIVE" \
		"https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}/llama-${LLAMA_RELEASE}-bin-ubuntu-x64.tar.gz"
	tar -xzf "$ARCHIVE" -C "$ROOT"
	rm -f "$ARCHIVE"
fi

if [[ ! -f "$MODEL_FILE" || ! -s "$MODEL_FILE" ]]; then
	echo "Downloading model…"
	tmp="$MODEL_FILE.part"
	curl -fsSL -o "$tmp" "$MODEL_URL"
	mv "$tmp" "$MODEL_FILE"
fi

cd "$BIN_DIR"
export LD_LIBRARY_PATH="$PWD:${LD_LIBRARY_PATH:-}"

if [[ -f "$PID_FILE" ]]; then
	old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
	if [[ -n "${old_pid:-}" ]] && kill -0 "$old_pid" 2>/dev/null; then
		kill "$old_pid" 2>/dev/null || true
		sleep 1
	fi
fi

# EXTRA_FLAGS is intentionally word-split to allow multiple flags (e.g. "--jinja --arg")
# shellcheck disable=SC2086
nohup ./llama-server -m "$MODEL_FILE" --host 127.0.0.1 --port "$LLAMA_PORT" $EXTRA_FLAGS >"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"

compat="http://127.0.0.1:${LLAMA_PORT}/v1"
for _ in $(seq 1 90); do
	if curl -fsS "$compat/models" >/dev/null 2>&1; then
		if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
			{
				echo "compat_url=$compat"
				echo "started=true"
			} >>"$GITHUB_OUTPUT"
		fi
		echo "llama-server ready at $compat"
		exit 0
	fi
	sleep 2
done

echo "::error::llama-server did not respond at $compat/models (see $LOG_FILE)"
tail -50 "$LOG_FILE" >&2 || true
exit 1
