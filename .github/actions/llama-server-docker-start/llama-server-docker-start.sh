#!/usr/bin/env bash
# Start llama.cpp llama-server in Docker (OpenAI-compatible /v1). Container listens on 8080; host maps LLAMA_PORT.
# On the host, OpenAI-compat base URL is http://127.0.0.1:${LLAMA_PORT}/v1 (same port as the action input).
# Uses docker/llama-server-image.tar under LLAMA_SERVER_ROOT when present (from actions/cache); otherwise pull + save.
set -euo pipefail

DOCKER_IMAGE="${DOCKER_IMAGE:?DOCKER_IMAGE required}"
MODEL_URL="${MODEL_URL:?MODEL_URL required}"
LLAMA_SERVER_ROOT="${LLAMA_SERVER_ROOT:?LLAMA_SERVER_ROOT required}"
LLAMA_PORT="${LLAMA_PORT:-8080}"
EXTRA_FLAGS="${EXTRA_FLAGS:-}"
CONTAINER_NAME="${CONTAINER_NAME:-auto-pr-llama}"

CONTAINER_INTERNAL_PORT=8080
# Must be a path that exists in the image before `docker cp` (images may omit /models).
IN_CONTAINER_MODEL=/tmp/auto-pr-model.gguf
IMAGE_TAR="$LLAMA_SERVER_ROOT/docker/llama-server-image.tar"

if [[ ! "$MODEL_URL" =~ ^https:// ]]; then
	echo "::error::MODEL_URL must be an https URL"
	exit 1
fi

ROOT="$LLAMA_SERVER_ROOT"
MODEL_FILE="$ROOT/model/model.gguf"

mkdir -p "$ROOT/model" "$ROOT/docker"

if [[ -f "$IMAGE_TAR" ]] && [[ -s "$IMAGE_TAR" ]]; then
	echo "Loading cached Docker image from $IMAGE_TAR…"
	docker load -i "$IMAGE_TAR"
else
	echo "Pulling ${DOCKER_IMAGE}…"
	docker pull "$DOCKER_IMAGE"
	echo "Saving image to $IMAGE_TAR for cache…"
	docker save "$DOCKER_IMAGE" -o "$IMAGE_TAR.part"
	mv "$IMAGE_TAR.part" "$IMAGE_TAR"
fi

if [[ ! -f "$MODEL_FILE" || ! -s "$MODEL_FILE" ]]; then
	echo "Downloading model…"
	tmp="$MODEL_FILE.part"
	curl -fsSL -o "$tmp" "$MODEL_URL"
	mv "$tmp" "$MODEL_FILE"
fi

docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

# Copy the GGUF into the container instead of bind-mounting. Nested Docker (e.g. nektos/act job
# containers using the host daemon) often maps `-v` host paths incorrectly; `docker cp` avoids that.
# shellcheck disable=SC2086
if ! docker create \
	--name "$CONTAINER_NAME" \
	-p "${LLAMA_PORT}:${CONTAINER_INTERNAL_PORT}" \
	"$DOCKER_IMAGE" \
	-m "$IN_CONTAINER_MODEL" \
	--port "$CONTAINER_INTERNAL_PORT" \
	--host 0.0.0.0 \
	$EXTRA_FLAGS; then
	echo "::error::docker create failed" >&2
	exit 1
fi
if ! docker cp "$MODEL_FILE" "$CONTAINER_NAME:$IN_CONTAINER_MODEL"; then
	echo "::error::docker cp model into container failed" >&2
	docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
	exit 1
fi
if ! docker start "$CONTAINER_NAME"; then
	echo "::error::docker start failed" >&2
	docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
	exit 1
fi

compat="http://127.0.0.1:${LLAMA_PORT}/v1"
for _ in $(seq 1 90); do
	if models_json="$(curl -fsS "$compat/models" 2>/dev/null)"; then
		model_id="$(
			printf '%s' "$models_json" | python3 -c 'import json, sys; data=json.load(sys.stdin); rows=data.get("data") or []; print((rows[0].get("id") if rows and isinstance(rows[0], dict) else "") or "")'
		)"
		if [[ -n "$model_id" && -n "${GITHUB_OUTPUT:-}" ]]; then
			echo "model_id=$model_id" >>"$GITHUB_OUTPUT"
		fi
		echo "llama-server ready at $compat"
		exit 0
	fi
	sleep 2
done

echo "::error::llama-server did not respond at $compat/models"
docker logs "$CONTAINER_NAME" >&2 || true
exit 1
