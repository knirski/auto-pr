#!/usr/bin/env bash
# Print the image ref from the first FROM line in .github/llama-server/Dockerfile (repo root = $1).
# Matches TS parsePinnedImageFromDockerfileContent: optional --flags, then first image token.
set -euo pipefail

ROOT="${1:?}"
DOCKERFILE="$ROOT/.github/llama-server/Dockerfile"

if [[ ! -f "$DOCKERFILE" ]]; then
	echo "error: missing $DOCKERFILE" >&2
	exit 1
fi

IMAGE="$(
	awk '
		/^[[:space:]]*#/ { next }
		/^[[:space:]]*FROM[[:space:]]/ {
			line = $0
			sub(/^[[:space:]]*[Ff][Rr][Oo][Mm][[:space:]]+/, "", line)
			sub(/[[:space:]]+[Aa][Ss][[:space:]].*$/, "", line)
			while (match(line, /^[[:space:]]*--[a-zA-Z0-9_-]+(=[^[:space:]]+)?[[:space:]]+/)) {
				line = substr(line, RSTART + RLENGTH)
			}
			gsub(/^[[:space:]]+/, "", line)
			match(line, /^[^[:space:]]+/)
			if (RSTART > 0) print substr(line, RSTART, RLENGTH)
			exit
		}
	' "$DOCKERFILE" | tr -d '\r'
)"

if [[ -z "$IMAGE" ]]; then
	echo "error: no usable FROM line in $DOCKERFILE" >&2
	exit 1
fi

printf '%s' "$IMAGE"
