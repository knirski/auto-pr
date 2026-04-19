#!/usr/bin/env bash
# Replace self-referential knirski/auto-pr refs with target SHA.
# Outputs: changed (true|false). In check_only mode, validates pins (see README).

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
USES_PATH_AT_SHA="${REPO}/([^[:space:]@]+)@([a-f0-9]{40})"

CHANGED="false"

gh_error() {
	echo "::error::$*"
	return 1
}

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

# Matches how GitHub resolves uses: owner/repo/.github/actions/name@sha (directory actions use action.yml in that folder).
object_path_in_repo() {
	local rel_path="$1"
	if [[ "$rel_path" == *.yml ]]; then
		printf '%s\n' "$rel_path"
	else
		printf '%s/action.yml\n' "$rel_path"
	fi
}

verify_self_pins_check_only() {
	local -a lines unique_shas
	local line rel_path object_path pin_sha err
	err=0

	collect_pin_lines_into lines
	[ "${#lines[@]}" -eq 0 ] && return 0

	# Self-refs must agree on one commit; mixed SHAs mean the repo would fetch inconsistent action trees from the same workflow run.
	mapfile -t unique_shas < <(printf '%s\n' "${lines[@]}" | grep -oE '@[a-f0-9]{40}' | sort -u)
	if [ "${#unique_shas[@]}" -ne 1 ]; then
		echo "::error::Self-referential pins must use exactly one 40-char SHA (found ${#unique_shas[@]}). All knirski/auto-pr/...@ lines must match."
		[[ ${#unique_shas[@]} -gt 1 ]] && printf '%s\n' "${unique_shas[@]}"
		return 1
	fi

	pin_sha="${unique_shas[0]#@}"
	if [ "$PINS_MUST_MATCH_TARGET" = "true" ] && [ "$pin_sha" != "$TARGET_SHA" ]; then
		gh_error "Stale pins: expected ${TARGET_SHA}, got ${pin_sha}. Run update-workflow-pins or align YAML."
		return 1
	fi
	if ! ensure_commit_available "$pin_sha"; then
		gh_error "Pin ${pin_sha} is not available locally and could not be fetched from ${GIT_REMOTE}. Try fetch-depth: 0 on checkout."
		return 1
	fi
	# HEAD is the checkout under test; the pin must lie on that history (not a random or fork-only commit).
	if ! git merge-base --is-ancestor "$pin_sha" HEAD; then
		gh_error "Pin commit ${pin_sha} is not an ancestor of HEAD (wrong fork, typo, or obsolete self-reference)."
		return 1
	fi

	# GitHub downloads each uses: path at the pinned commit; missing paths fail at runtime, not at YAML parse time.
	while IFS= read -r line; do
		[[ "$line" =~ $USES_PATH_AT_SHA ]] || continue
		rel_path="${BASH_REMATCH[1]}"
		if [[ "$rel_path" != .github/* ]]; then
			echo "::error::Self-referential path must start with .github/ (got ${rel_path})"
			err=1
			continue
		fi
		object_path="$(object_path_in_repo "$rel_path")"
		git cat-file -e "$pin_sha:${object_path}" 2>/dev/null || {
			echo "::error::Pinned commit ${pin_sha} does not contain ${object_path}"
			err=1
		}
	done < <(printf '%s\n' "${lines[@]}")

	return "$err"
}

# --- main ---
if [ "$CHECK_ONLY" = "true" ]; then
	verify_self_pins_check_only || CHANGED="true"
	write_output
	# Composite contract: non-zero when verification failed so CI can gate without mutating the tree.
	[ "$CHANGED" = "true" ] && exit 1
	exit 0
fi

# Write mode: bump every self-ref to TARGET_SHA (typically github.sha of the push that touched workflows/actions).
while IFS= read -r file; do
	grep -qE "$PIN_MATCH" "$file" 2>/dev/null || continue
	NEW_CONTENT=$(sed -E "$SED_REPLACE" "$file")
	if [ "$(cat "$file")" != "$NEW_CONTENT" ]; then
		echo "$NEW_CONTENT" >"$file"
		CHANGED="true"
	fi
done < <(pin_candidate_files)

write_output
