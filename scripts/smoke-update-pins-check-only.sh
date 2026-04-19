#!/usr/bin/env bash
# Smoke-test update-pins.sh check_only (uniform pin, ancestor, paths, fetch fallback).

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

export GITHUB_SHA
GITHUB_SHA="$(git rev-parse HEAD)"
export INPUT_CHECK_ONLY=true
export INPUT_PINS_MUST_MATCH_TARGET=false
export GITHUB_OUTPUT="$OUT"

bash .github/actions/update-workflow-pins/update-pins.sh
