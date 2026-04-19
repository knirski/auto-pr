#!/usr/bin/env bash
# Replace self-referential knirski/auto-pr refs with target SHA.
# Outputs: changed (true|false). In check_only mode, validates pins without writing.

set -euo pipefail

TARGET_SHA="${INPUT_TARGET_SHA:-$GITHUB_SHA}"
REPO="${INPUT_REPO:-knirski/auto-pr}"
CHECK_ONLY="${INPUT_CHECK_ONLY:-false}"
# Default off: on main, pins often lag HEAD until the next workflows/actions push; requiring pin == HEAD would false-fail that normal state.
PINS_MUST_MATCH_TARGET="${INPUT_PINS_MUST_MATCH_TARGET:-false}"
GIT_REMOTE="${INPUT_GIT_REMOTE:-origin}"

REPO_ESC="${REPO//\//\\/}"
PIN_MATCH="uses:.*${REPO}[^@]+@[a-f0-9]{40}"
SED_REPLACE="s/(uses:.*${REPO_ESC}[^@]+@)[a-f0-9]{40}/\\1${TARGET_SHA}/g"
# Regex for path@sha after repo/ (check_only path existence).
USES_PATH_AT_SHA="${REPO}/([^[:space:]@]+)@([a-f0-9]{40})"

CHANGED="false"

append_github_output() {
	if [ -n "${GITHUB_OUTPUT:-}" ]; then
		echo "changed=$CHANGED" >>"$GITHUB_OUTPUT"
	fi
}

# check_only: all uses: refs share one SHA, that commit is an ancestor of HEAD, and each path exists at that commit.
verify_pins_uniform() {
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
	if ! git rev-parse -q --verify "$p^{commit}" >/dev/null 2>&1; then
		echo "::error::Pin $p is not a valid commit in this repository"
		return 1
	fi

	if ! git merge-base --is-ancestor "$p" HEAD; then
		echo "::error::Pin commit $p is not an ancestor of HEAD (wrong or obsolete self-reference)"
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
	if ! verify_pins_uniform; then
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

write_output() {
	[ -n "${GITHUB_OUTPUT:-}" ] && echo "changed=$CHANGED" >>"$GITHUB_OUTPUT"
}

# Workflows and composites that might reference knirski/auto-pr@…. Skip this action's tree so we never rewrite or validate pins inside the updater itself.
pin_candidate_files() {
	local f
	for f in .github/workflows/*.yml .github/actions/*/*.yml .github/actions/*/*/*.yml; do
		[ -f "$f" ] || continue
		[[ "$f" == *"update-workflow-pins"* ]] && continue
		printf '%s\n' "$f"
	done
}

# All matching uses: lines across the repo (uniform SHA and path checks are global, not per file).
collect_pin_lines_into() {
	local -n _out="$1"
	local file chunk
	_out=()
	while IFS= read -r file; do
		mapfile -t chunk < <(grep -E "$PIN_MATCH" "$file" 2>/dev/null || true)
		((${#chunk[@]} > 0)) && _out+=("${chunk[@]}")
	done < <(pin_candidate_files)
}

# Pin validation uses git rev-parse / cat-file; shallow checkouts and tools like act often omit those objects even when the pin is valid on GitHub.
ensure_commit_available() {
	local sha="$1"
	git rev-parse -q --verify "$sha^{commit}" >/dev/null 2>&1 && return 0
	if git remote get-url "$GIT_REMOTE" >/dev/null 2>&1; then
		# CI fetches must not block on a TTY for credentials.
		export GIT_TERMINAL_PROMPT=0
		git fetch -q --no-tags --no-recurse-submodules "$GIT_REMOTE" "$sha" 2>/dev/null ||
			git fetch -q --no-tags --unshallow 2>/dev/null ||
			git fetch -q --no-tags --deepen=2147483647 "$GIT_REMOTE" 2>/dev/null ||
			true
	fi
	git rev-parse -q --verify "$sha^{commit}" >/dev/null 2>&1
}

	NEW_CONTENT=$(sed -E "$SED_REPLACE" "$file")
	if [ "$(cat "$file")" != "$NEW_CONTENT" ]; then
		echo "$NEW_CONTENT" >"$file"
		CHANGED="true"
	fi
}

append_github_output
