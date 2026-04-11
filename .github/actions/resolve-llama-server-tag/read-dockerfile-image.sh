#!/usr/bin/env bash
# Print ggml-org/llama.cpp image reference from .github/llama-ci/Dockerfile FROM line (repo root = $1).
set -euo pipefail

ROOT="${1:?}"
DOCKERFILE="$ROOT/.github/llama-ci/Dockerfile"

if [[ ! -f "$DOCKERFILE" ]]; then
	echo "error: missing $DOCKERFILE" >&2
	exit 1
fi

LINE="$(grep -E '^FROM ghcr.io/ggml-org/llama.cpp:' "$DOCKERFILE" | head -1)"
if [[ -z "$LINE" ]]; then
	echo "error: expected FROM ghcr.io/ggml-org/llama.cpp:... in $DOCKERFILE" >&2
	exit 1
fi

IMAGE="$(printf '%s' "$LINE" | awk '{print $2}' | tr -d '\r')"
if [[ -z "$IMAGE" ]]; then
	echo "error: could not parse image from $DOCKERFILE" >&2
	exit 1
fi

printf '%s' "$IMAGE"
