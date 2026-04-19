#!/usr/bin/env bash
# Composite: write tag= / image= to GITHUB_OUTPUT when local llama is needed (NEED via ci-local-llama-docker-need.sh).
# CLI: --dockerfile-image <repo-root> → print image ref from first FROM (parity tests). --help → usage.
# Matches test/integration/dockerfile-from-image.ts (optional --flags, then first image token).

readonly LLAMA_SERVER_DOCKERFILE_REL='.github/llama-server/Dockerfile'
_resolve_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly _resolve_script_dir
readonly _PARSE_FIRST_FROM_DOCKERFILE_AWK="$_resolve_script_dir/parse-first-from-dockerfile.awk"

read_llama_server_dockerfile_image_from_root() {
	local root="$1"
	local dockerfile="$root/$LLAMA_SERVER_DOCKERFILE_REL"

	if [[ ! -f "$dockerfile" ]]; then
		echo "error: missing $dockerfile" >&2
		return 1
	fi

	local image
	image="$(awk -f "$_PARSE_FIRST_FROM_DOCKERFILE_AWK" "$dockerfile" | tr -d '\r')"

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
	local hex_hash
	if [[ "$img" =~ @sha256:([a-f0-9]{64}) ]]; then
		printf '%s' "${BASH_REMATCH[1]:0:12}"
		return
	fi
	hex_hash=$(printf '%s' "$img" | sha256sum)
	hex_hash="${hex_hash%% *}"
	printf '%s' "${hex_hash:0:12}"
}

# Accept true / True / TRUE / 1 / yes (GitHub sometimes coerces booleans oddly).
always_resolve="${ALWAYS_RESOLVE_TAG:-false}"
case "${always_resolve,,}" in
true | 1 | yes) ;; # skip NEED gate
*)
	need_script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ci-local-llama-docker-need.sh"
	local_llama_docker_need="$(bash "$need_script_path")"
	if [[ "$local_llama_docker_need" != "true" ]]; then
		printf 'tag=\nimage=\n' >>"$GITHUB_OUTPUT"
		exit 0
	fi
	;;
esac

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
