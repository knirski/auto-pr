#!/usr/bin/env bash
# Append committed .env.ci to GITHUB_ENV and optionally derive AUTO_PR_AI_OPENAI_COMPAT_URL from INTEGRATION_LLAMA_PORT.
set -euo pipefail

: "${GITHUB_ENV:?}"
: "${GITHUB_WORKSPACE:?}"

env_file="$GITHUB_WORKSPACE/.env.ci"
if [[ ! -f "$env_file" ]]; then
	echo "::error::missing $env_file" >&2
	exit 1
fi

omit_raw="${LOAD_ENV_CI_OMIT_LLAMA_INTEGRATION:-false}"
if [[ "$omit_raw" == "true" || "$omit_raw" == "1" ]]; then
	awk '!/^[[:space:]]*#/ && $0 !~ /^INTEGRATION_LLAMA/ && NF' "$env_file" >>"$GITHUB_ENV"
else
	awk '!/^[[:space:]]*#/ && NF' "$env_file" >>"$GITHUB_ENV"
	port=$(grep -E '^INTEGRATION_LLAMA_PORT=' "$env_file" | head -1 | cut -d= -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/\r$//')
	if [[ -z "${port:-}" ]]; then
		echo "::error::INTEGRATION_LLAMA_PORT missing or empty in $env_file" >&2
		exit 1
	fi
	echo "AUTO_PR_AI_OPENAI_COMPAT_URL=http://127.0.0.1:${port}/v1" >>"$GITHUB_ENV"
fi
