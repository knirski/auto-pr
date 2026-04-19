#!/usr/bin/env bash
# CI only: true/false whether auto-pr generate uses the local Docker llama path (NEED rule — same predicate as
# auto-pr-generate-reusable.yml cache/start if:).
#
# Environment (optional unless noted):
#   COMMITS_COUNT           semantic (non-merge) commit count; empty may be filled from semantic_subjects.txt
#   GITHUB_WORKSPACE        repo root when using semantic_subjects.txt fallback
#   AI_PROVIDER             must be "local" for NEED
#   AI_LLAMACPP_MODEL_URL   non-empty GGUF URL for NEED
#   AI_OPENAI_COMPAT_URL    must be empty for NEED (external compat URL ⇒ no bundled Docker llama path)
#
# Prints: true or false (single line, stdout).

set -euo pipefail

commits_count="${COMMITS_COUNT:-}"
github_workspace="${GITHUB_WORKSPACE:-}"
if [[ -z "$commits_count" && -n "$github_workspace" && -f "$github_workspace/semantic_subjects.txt" ]]; then
	commits_count=$(wc -l <"$github_workspace/semantic_subjects.txt" | tr -d ' \n\r')
fi
ai_provider="${AI_PROVIDER:-}"
ai_llamacpp_model_url="${AI_LLAMACPP_MODEL_URL:-}"
ai_openai_compat_url="${AI_OPENAI_COMPAT_URL:-}"
# Require explicit count: empty (e.g. missing composite outputs) must not imply "multi-commit".
if [[ -n "$commits_count" && "$commits_count" != "1" ]] && [[ "$ai_provider" == "local" ]] && [[ -n "$ai_llamacpp_model_url" ]] && [[ -z "$ai_openai_compat_url" ]]; then
	echo "true"
else
	echo "false"
fi
