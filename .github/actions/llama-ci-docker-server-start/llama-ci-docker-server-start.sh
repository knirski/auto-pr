#!/usr/bin/env bash
# Start llama.cpp llama-server in Docker (OpenAI-compatible /v1). Container listens on 8080; host maps LLAMA_PORT.
# Uses docker/llama-ci-image.tar under LLAMA_CI_ROOT when present (from actions/cache); otherwise pull + save.
set -euo pipefail

DOCKER_IMAGE="${DOCKER_IMAGE:?DOCKER_IMAGE required}"
MODEL_URL="${MODEL_URL:?MODEL_URL required}"
LLAMA_CI_ROOT="${LLAMA_CI_ROOT:?LLAMA_CI_ROOT required}"
LLAMA_PORT="${LLAMA_PORT:-8080}"
EXTRA_FLAGS="${EXTRA_FLAGS:-}"
CONTAINER_NAME="${CONTAINER_NAME:-auto-pr-llama}"

CONTAINER_INTERNAL_PORT=8080
IMAGE_TAR="$LLAMA_CI_ROOT/docker/llama-ci-image.tar"

if [[ ! "$MODEL_URL" =~ ^https:// ]]; then
	echo "::error::MODEL_URL must be an https URL"
	exit 1
fi

ROOT="$LLAMA_CI_ROOT"
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

# shellcheck disable=SC2086
if ! docker run -d \
	--name "$CONTAINER_NAME" \
	-p "${LLAMA_PORT}:${CONTAINER_INTERNAL_PORT}" \
	-v "${MODEL_FILE}:/models/model.gguf:ro" \
	"$DOCKER_IMAGE" \
	-m /models/model.gguf \
	--port "$CONTAINER_INTERNAL_PORT" \
	--host 0.0.0.0 \
	$EXTRA_FLAGS; then
	echo "::error::docker run failed" >&2
	exit 1
fi

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

echo "::error::llama-server did not respond at $compat/models"
docker logs "$CONTAINER_NAME" >&2 || true
exit 1
