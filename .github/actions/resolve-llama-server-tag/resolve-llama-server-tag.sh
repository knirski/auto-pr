#!/usr/bin/env bash
# Composite step: write tag= (cache slug) and image= (docker pull ref) to GITHUB_OUTPUT when local llama is needed.
# NEED rule must stay in sync with cache/start local llama if: in auto-pr-generate-reusable.yml.
set -euo pipefail

: "${GITHUB_OUTPUT:?}"
: "${GITHUB_WORKSPACE:?}"
: "${GITHUB_ACTION_PATH:?}"

READ_IMAGE="$GITHUB_ACTION_PATH/read-dockerfile-image.sh"

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
elif [[ -f "$GITHUB_WORKSPACE/.github/llama-server/Dockerfile" ]]; then
	IMAGE="$(bash "$READ_IMAGE" "$GITHUB_WORKSPACE")"
else
	echo "::error::Local llama requires .github/llama-server/Dockerfile (run auto-pr-init) or inputs.ai_llamacpp_release_tag." >&2
	exit 1
fi

SLUG="$(cache_slug_from_image "$IMAGE")"
{
	echo "tag=$SLUG"
	echo "image=$IMAGE"
} >>"$GITHUB_OUTPUT"
