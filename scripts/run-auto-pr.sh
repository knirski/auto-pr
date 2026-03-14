#!/usr/bin/env bash
# Run the auto-PR pipeline locally (no GitHub Actions).
# Requires: DEFAULT_BRANCH (default: main), GITHUB_WORKSPACE (default: .), GH_TOKEN.
# For 2+ commits: Ollama must be running (default: localhost:11434).

set -euo pipefail

WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
BRANCH="${BRANCH:-$(git branch --show-current)}"
GH_OUTPUT=$(mktemp)
trap 'rm -f "$GH_OUTPUT"' EXIT

export GITHUB_WORKSPACE="$WORKSPACE"
export GITHUB_OUTPUT="$GH_OUTPUT"

echo "=== Step 1: Get commits ==="
npx tsx scripts/auto-pr-get-commits.ts

# Parse GITHUB_OUTPUT (key=value, one per line)
commits=$(grep '^commits=' "$GH_OUTPUT" | cut -d= -f2-)
files=$(grep '^files=' "$GH_OUTPUT" | cut -d= -f2-)

echo "=== Step 2: Generate PR content ==="
export COMMITS="$commits"
export FILES="$files"
npx tsx scripts/generate-pr-content.ts

title_raw=$(grep '^title=' "$GH_OUTPUT" | tail -1 | cut -d= -f2-)
title=$(node -e "try { console.log(decodeURIComponent(process.argv[1] || '')); } catch { console.log(process.argv[1] || ''); }" "$title_raw")
body_file=$(grep '^body_file=' "$GH_OUTPUT" | tail -1 | cut -d= -f2-)

echo "=== Step 3: Create or update PR ==="
export BRANCH="$BRANCH"
export DEFAULT_BRANCH="$DEFAULT_BRANCH"
export TITLE="$title"
export BODY_FILE="$body_file"
npx tsx scripts/create-or-update-pr.ts

echo "=== Done ==="
