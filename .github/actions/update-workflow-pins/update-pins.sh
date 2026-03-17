#!/usr/bin/env bash
# Replace self-referential knirski/auto-pr refs with target SHA.
# Outputs: changed (true|false). In check_only mode, exits 1 if pins are stale.

set -euo pipefail

TARGET_SHA="${INPUT_TARGET_SHA:-$GITHUB_SHA}"
REPO="${INPUT_REPO:-knirski/auto-pr}"
CHECK_ONLY="${INPUT_CHECK_ONLY:-false}"

# Escape slashes for sed
REPO_ESC="${REPO//\//\\/}"

# Match uses: lines with repo/path@40-char-hex (e.g. uses: knirski/auto-pr/.github/workflows/foo.yml@abc123...)
# Pattern: uses: + repo + path + @ + 40 hex chars
PIN_MATCH="uses:.*${REPO}[^@]+@[a-f0-9]{40}"
# Sed replacement: capture prefix (uses:...@), replace 40-char SHA with target
SED_REPLACE="s/(uses:.*${REPO_ESC}[^@]+@)[a-f0-9]{40}/\\1${TARGET_SHA}/g"

CHANGED="false"

for file in .github/workflows/*.yml .github/actions/*/*.yml .github/actions/*/*/*.yml; do
	[ -f "$file" ] || continue
	[[ "$file" == *"update-workflow-pins"* ]] && continue

	if ! grep -qE "$PIN_MATCH" "$file" 2>/dev/null; then
		continue
	fi

	if [ "$CHECK_ONLY" = "true" ]; then
		if grep -E "$PIN_MATCH" "$file" | grep -qv "@${TARGET_SHA}"; then
			CHANGED="true"
			echo "::error::Stale pins in $file (expected $TARGET_SHA)"
		fi
	else
		NEW_CONTENT=$(sed -E "$SED_REPLACE" "$file")
		if [ "$(cat "$file")" != "$NEW_CONTENT" ]; then
			echo "$NEW_CONTENT" >"$file"
			CHANGED="true"
		fi
	fi
done

echo "changed=$CHANGED" >>"$GITHUB_OUTPUT"

if [ "$CHECK_ONLY" = "true" ] && [ "$CHANGED" = "true" ]; then
	exit 1
fi
