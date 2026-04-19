#!/usr/bin/env bash
# Replace self-referential knirski/auto-pr refs with target SHA.
# Outputs: changed (true|false). In check_only mode, validates pins (see README).

set -euo pipefail

TARGET_SHA="${INPUT_TARGET_SHA:-$GITHUB_SHA}"
REPO="${INPUT_REPO:-knirski/auto-pr}"
CHECK_ONLY="${INPUT_CHECK_ONLY:-false}"
# When true, require the uniform pin to equal TARGET_SHA (e.g. right after update-workflow-pins bot).
# Default false: only require one SHA, ancestor of HEAD, and paths at that commit (matches normal main
# where pins trail the tip until the next workflow-touching commit).
PINS_MUST_MATCH_TARGET="${INPUT_PINS_MUST_MATCH_TARGET:-false}"
GIT_REMOTE="${INPUT_GIT_REMOTE:-origin}"

# Escape slashes for sed
REPO_ESC="${REPO//\//\\/}"

# Match uses: lines with repo/path@40-char-hex (e.g. uses: knirski/auto-pr/.github/workflows/foo.yml@abc123...)
PIN_MATCH="uses:.*${REPO}[^@]+@[a-f0-9]{40}"
SED_REPLACE="s/(uses:.*${REPO_ESC}[^@]+@)[a-f0-9]{40}/\\1${TARGET_SHA}/g"
USES_PATH_AT_SHA="${REPO}/([^[:space:]@]+)@([a-f0-9]{40})"

CHANGED="false"

append_github_output() {
	if [ -n "${GITHUB_OUTPUT:-}" ]; then
		echo "changed=$CHANGED" >>"$GITHUB_OUTPUT"
	fi
}

# Best-effort: ensure commit object exists locally. Common fix for shallow / partial clones (CI, act).
# git fetch <remote> <sha> works when the server advertises the commit (GitHub does for in-repo SHAs).
ensure_commit_available() {
	local c="$1"
	if git rev-parse -q --verify "$c^{commit}" >/dev/null 2>&1; then
		return 0
	fi
	if git remote get-url "$GIT_REMOTE" >/dev/null 2>&1; then
		GIT_TERMINAL_PROMPT=0 git fetch -q --no-tags --no-recurse-submodules "$GIT_REMOTE" "$c" 2>/dev/null ||
			GIT_TERMINAL_PROMPT=0 git fetch -q --no-tags --unshallow 2>/dev/null ||
			GIT_TERMINAL_PROMPT=0 git fetch -q --no-tags --deepen=2147483647 "$GIT_REMOTE" 2>/dev/null ||
			true
	fi
	git rev-parse -q --verify "$c^{commit}" >/dev/null 2>&1
}

# check_only: one uniform SHA; optional equality to TARGET_SHA; commit reachable and contains each path.
verify_self_pins_check_only() {
	local line rel_path object_path unique c p err file
	err=0
	local lines=()
	for file in .github/workflows/*.yml .github/actions/*/*.yml .github/actions/*/*/*.yml; do
		[ -f "$file" ] || continue
		[[ "$file" == *"update-workflow-pins"* ]] && continue
		while IFS= read -r line; do
			lines+=("$line")
		done < <(grep -E "$PIN_MATCH" "$file" 2>/dev/null || true)
	done
	if [ "${#lines[@]}" -eq 0 ]; then
		return 0
	fi

	mapfile -t unique < <(printf '%s\n' "${lines[@]}" | grep -oE '@[a-f0-9]{40}' | sort -u)
	c="${#unique[@]}"
	if [ "$c" -eq 0 ]; then
		echo "::error::Could not extract a 40-character pin SHA from self-referential uses: lines (unexpected format?)"
		return 1
	fi
	if [ "$c" -ne 1 ]; then
		echo "::error::Multiple self-referential pin SHAs (${c}). All knirski/auto-pr/...@ refs must use the same commit."
		printf '%s\n' "${unique[@]}"
		return 1
	fi

	p="${unique[0]#@}"
	if [ "$PINS_MUST_MATCH_TARGET" = "true" ] && [ "$p" != "$TARGET_SHA" ]; then
		echo "::error::Stale pins: expected ${TARGET_SHA}, got ${p}. Run update-workflow-pins or align YAML."
		return 1
	fi

	if ! ensure_commit_available "$p"; then
		echo "::error::Pin $p is not available locally and could not be fetched from ${GIT_REMOTE} (network or shallow clone?). Try fetch-depth: 0 on checkout."
		return 1
	fi

	if ! git merge-base --is-ancestor "$p" HEAD; then
		echo "::error::Pin commit $p is not an ancestor of HEAD (wrong fork, typo, or obsolete self-reference)."
		return 1
	fi

	while IFS= read -r line; do
		[[ "$line" =~ $USES_PATH_AT_SHA ]] || continue
		rel_path="${BASH_REMATCH[1]}"
		if [[ "$rel_path" != .github/* ]]; then
			echo "::error::Self-referential path must start with .github/ (got ${rel_path} from workflow line)"
			err=1
			continue
		fi
		if [[ "$rel_path" == *.yml ]]; then
			object_path="$rel_path"
		else
			object_path="${rel_path}/action.yml"
		fi
		if ! git cat-file -e "$p:${object_path}" 2>/dev/null; then
			echo "::error::Pinned commit $p does not contain ${object_path} (from workflow line)"
			err=1
		fi
	done < <(printf '%s\n' "${lines[@]}")

	return "$err"
}

if [ "$CHECK_ONLY" = "true" ]; then
	if ! verify_self_pins_check_only; then
		CHANGED="true"
	fi
	append_github_output
	if [ "$CHANGED" = "true" ]; then
		exit 1
	fi
	exit 0
fi

for file in .github/workflows/*.yml .github/actions/*/*.yml .github/actions/*/*/*.yml; do
	[ -f "$file" ] || continue
	[[ "$file" == *"update-workflow-pins"* ]] && continue

	if ! grep -qE "$PIN_MATCH" "$file" 2>/dev/null; then
		continue
	fi

	NEW_CONTENT=$(sed -E "$SED_REPLACE" "$file")
	if [ "$(cat "$file")" != "$NEW_CONTENT" ]; then
		echo "$NEW_CONTENT" >"$file"
		CHANGED="true"
	fi
done

append_github_output
