#!/usr/bin/env bash
# Print ggml-org/llama.cpp GHCR server-<tag> from .github/llama-ci/Dockerfile (repo root = $1).
set -euo pipefail

ROOT="${1:?}"
DOCKERFILE="$ROOT/.github/llama-ci/Dockerfile"

if [[ ! -f "$DOCKERFILE" ]]; then
	echo "error: missing $DOCKERFILE" >&2
	exit 1
fi

PIN="$(grep -E '^FROM ghcr.io/ggml-org/llama.cpp:server-' "$DOCKERFILE" | head -1 | sed 's/.*:server-//' | tr -d '\r')"
if [[ -z "$PIN" ]]; then
	echo "error: could not parse release pin from $DOCKERFILE (expected FROM ghcr.io/ggml-org/llama.cpp:server-<tag>)" >&2
	exit 1
fi

printf '%s' "$PIN"
