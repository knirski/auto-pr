#!/usr/bin/env bash
# Print .image from .github/llama-ci/llama-ci.json (repo root = $1).
set -euo pipefail

ROOT="${1:?}"
JSON="$ROOT/.github/llama-ci/llama-ci.json"

if [[ ! -f "$JSON" ]]; then
	echo "error: missing $JSON" >&2
	exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
	echo "error: jq is required to read llama-ci.json" >&2
	exit 1
fi

IMAGE="$(jq -r '.image // empty' "$JSON" | tr -d '\r')"
if [[ -z "$IMAGE" || "$IMAGE" == "null" ]]; then
	echo "error: .image missing or empty in $JSON" >&2
	exit 1
fi

printf '%s' "$IMAGE"
