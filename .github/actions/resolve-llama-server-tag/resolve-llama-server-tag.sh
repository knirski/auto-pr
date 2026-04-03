#!/usr/bin/env bash
# Composite step: write tag= to GITHUB_OUTPUT (empty when local llama not needed).
# NEED rule must stay in sync with cache/start local llama if: in auto-pr-generate-reusable.yml.
set -euo pipefail

: "${GITHUB_OUTPUT:?}"
: "${GITHUB_WORKSPACE:?}"
: "${GITHUB_ACTION_PATH:?}"

READ_TAG="$GITHUB_ACTION_PATH/read-dockerfile-tag.sh"

# Accept true / True / TRUE / 1 / yes (GitHub sometimes coerces booleans oddly).
always_raw="${ALWAYS_RESOLVE_TAG:-false}"
always_lc="${always_raw,,}"
if [[ "$always_lc" != "true" && "$always_lc" != "1" && "$always_lc" != "yes" ]]; then
	C="${COMMITS_COUNT:?}"
	AP="${AI_PROVIDER:?}"
	MU="${AI_LLAMACPP_MODEL_URL:-}"
	CU="${AI_OPENAI_COMPAT_URL:-}"
	NEED=false
	if [[ "$C" != "1" ]] && [[ "$AP" == "local" ]] && [[ -n "$MU" ]] && [[ -z "$CU" ]]; then
		NEED=true
	fi
	if [[ "$NEED" == "false" ]]; then
		echo "tag=" >>"$GITHUB_OUTPUT"
		exit 0
	fi
fi

INPUT_TAG="${AI_LLAMACPP_RELEASE_TAG:-}"
if [[ -n "$INPUT_TAG" ]]; then
	echo "tag=$INPUT_TAG" >>"$GITHUB_OUTPUT"
elif [[ -f "$GITHUB_WORKSPACE/.github/llama-ci/Dockerfile" ]]; then
	tag=$(bash "$READ_TAG" "$GITHUB_WORKSPACE")
	echo "tag=$tag" >>"$GITHUB_OUTPUT"
else
	echo "::error::Local llama requires .github/llama-ci/Dockerfile (run auto-pr-init) or inputs.ai_llamacpp_release_tag." >&2
	exit 1
fi
