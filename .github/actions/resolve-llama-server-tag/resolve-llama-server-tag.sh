#!/usr/bin/env bash
# Composite: write tag= / image= to GITHUB_OUTPUT when local llama is needed (NEED rule matches auto-pr-generate-reusable).
# CLI: --dockerfile-image <repo-root> → print image ref from first FROM (parity tests). --help → usage.
# Matches test/integration/dockerfile-from-image.ts (optional --flags, then first image token).

readonly LLAMA_SERVER_DOCKERFILE_REL='.github/llama-server/Dockerfile'

read_llama_server_dockerfile_image_from_root() {
	local root="$1"
	local dockerfile="$root/$LLAMA_SERVER_DOCKERFILE_REL"

	if [[ ! -f "$dockerfile" ]]; then
		echo "error: missing $dockerfile" >&2
		return 1
	fi

	local image
	image="$(
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
		' "$dockerfile" | tr -d '\r'
	)"

	if [[ -z "$image" ]]; then
		echo "error: no usable FROM line in $dockerfile" >&2
		return 1
	fi

	printf '%s' "$image"
}

case "${1:-}" in
--dockerfile-image)
	set -euo pipefail
	read_llama_server_dockerfile_image_from_root "${2:?}"
	exit
	;;
--help | -h)
	printf '%s\n' "Usage: ${0##*/} [--dockerfile-image <repo-root> | --help]" >&2
	printf '%s\n' "  (no args)  GitHub Actions composite: write tag= and image= to GITHUB_OUTPUT." >&2
	exit 0
	;;
esac

set -euo pipefail

: "${GITHUB_OUTPUT:?}"
: "${GITHUB_WORKSPACE:?}"

cache_slug_from_image() {
	local img="$1"
	if [[ "$img" =~ @sha256:([a-f0-9]{64}) ]]; then
		local d="${BASH_REMATCH[1]}"
		printf '%s' "${d:0:12}"
		return
	fi
	printf '%s' "$img" | sha256sum | awk '{print substr($1,1,12)}'
}

# Accept true / True / TRUE / 1 / yes (GitHub sometimes coerces booleans oddly).
always_raw="${ALWAYS_RESOLVE_TAG:-false}"
always_lc="${always_raw,,}"
if [[ "$always_lc" != "true" && "$always_lc" != "1" && "$always_lc" != "yes" ]]; then
	# Empty count/provider can happen if a caller omits composite outputs; treat as non-NEED.
	C="${COMMITS_COUNT:-}"
	# Composite actions do not always surface GITHUB_OUTPUT from child processes (e.g. bun) to
	# steps.run.outputs.* — fall back: semantic_subjects.txt line count == semantic commit count.
	if [[ -z "$C" && -f "$GITHUB_WORKSPACE/semantic_subjects.txt" ]]; then
		C=$(wc -l <"$GITHUB_WORKSPACE/semantic_subjects.txt" | tr -d ' \n\r')
	fi
	AP="${AI_PROVIDER:-}"
	MU="${AI_LLAMACPP_MODEL_URL:-}"
	CU="${AI_OPENAI_COMPAT_URL:-}"
	NEED=false
	# Require explicit count: empty (e.g. missing composite outputs) must not imply "multi-commit".
	if [[ -n "$C" && "$C" != "1" ]] && [[ "$AP" == "local" ]] && [[ -n "$MU" ]] && [[ -z "$CU" ]]; then
		NEED=true
	fi
	if [[ "$NEED" == "false" ]]; then
		{
			echo "tag="
			echo "image="
		} >>"$GITHUB_OUTPUT"
		exit 0
	fi
fi

INPUT_TAG="${AI_LLAMACPP_RELEASE_TAG:-}"
if [[ -n "$INPUT_TAG" ]]; then
	if [[ "$INPUT_TAG" == */* || "$INPUT_TAG" == *:* || "$INPUT_TAG" == *@* ]]; then
		IMAGE="$INPUT_TAG"
	else
		IMAGE="ghcr.io/ggml-org/llama.cpp:server-${INPUT_TAG}"
	fi
elif [[ -f "$GITHUB_WORKSPACE/$LLAMA_SERVER_DOCKERFILE_REL" ]]; then
	IMAGE="$(read_llama_server_dockerfile_image_from_root "$GITHUB_WORKSPACE")"
else
	echo "::error::Local llama requires $LLAMA_SERVER_DOCKERFILE_REL (run auto-pr-init) or inputs.ai_llamacpp_release_tag." >&2
	exit 1
fi

SLUG="$(cache_slug_from_image "$IMAGE")"
{
	echo "tag=$SLUG"
	echo "image=$IMAGE"
} >>"$GITHUB_OUTPUT"
