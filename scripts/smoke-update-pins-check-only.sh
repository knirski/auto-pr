#!/usr/bin/env bash
# Smoke-test update-pins.sh check_only mode (guards regressions in verify_self_pins_check_only).
#
# Cases:
#   1. Positive (real tree): the current checkout — every uses:@sha pin AND the github:...#sha
#      executor pin agree on one SHA and validate cleanly.
#   2. Positive (temp git repo): a synthetic repo whose uses: and executor pins agree — proves the
#      fixture is valid and the executor pin passes the full git path (ancestor + package.json).
#   3. Mismatch (temp git repo): same fixture with the executor pin bumped to a DIFFERENT (still
#      valid, still-ancestor) SHA — must fail. Before Task 1.5 the executor SHA was never collected,
#      so this case would have PASSED (the gap this test guards). Uses real git objects/history so
#      the check runs through the same rev-parse/cat-file/merge-base logic as CI, not a mock.

set -euo pipefail

# This script runs from lefthook's pre-commit hook, where git exports GIT_DIR / GIT_INDEX_FILE /
# GIT_WORK_TREE etc. pointing at the REAL repo. If left set, the throwaway git fixtures below would
# init/commit against the real repo instead of their temp dir (corrupting HEAD/index mid-commit).
# Clear them so every git call — including `git init` in the fixtures — uses filesystem discovery
# from the cwd. Harmless when run standalone (the vars are simply not set).
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
	GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_NAMESPACE GIT_PREFIX

ROOT="$(git rev-parse --show-toplevel)"
SCRIPT="$ROOT/.github/actions/update-workflow-pins/update-pins.sh"

# --- case 1: current real tree -------------------------------------------------------------------
run_real_tree_positive() {
	local out
	out="$(mktemp)"
	(
		cd "$ROOT"
		GITHUB_SHA="$(git rev-parse HEAD)" INPUT_CHECK_ONLY=true GITHUB_OUTPUT="$out" \
			bash "$SCRIPT"
	)
	rm -f "$out"
	echo "PASS: current tree validates (uses: + executor pins agree)"
}

# Build a throwaway git repo whose HEAD carries a uses: pin and an executor pin, both on an earlier
# ancestor commit that contains the referenced action path and package.json.
# Prints the temp dir path (caller removes it). Both pins share $PIN_SHA on success.
build_fixture() {
	local dir
	dir="$(mktemp -d)"
	(
		cd "$dir"
		git init -q
		git config user.email smoke@example.com
		git config user.name smoke
		git config commit.gpgsign false

		# Commit 1: the referenced action path + package.json must exist AT the pinned commit.
		mkdir -p .github/workflows
		printf 'name: reusable\non: workflow_call\njobs: {}\n' >.github/workflows/reusable.yml
		printf '{ "name": "auto-pr" }\n' >package.json
		git add -A
		git commit -q -m base
		local pin_sha
		pin_sha="$(git rev-parse HEAD)"

		# Commit 2 = HEAD: the pin file referencing commit 1 from both pin shapes.
		{
			printf 'jobs:\n  call:\n    uses: knirski/auto-pr/.github/workflows/reusable.yml@%s\n' "$pin_sha"
			printf '  install:\n    steps:\n      - run: |\n          EXECUTOR_PKG="github:knirski/auto-pr#%s"\n' "$pin_sha"
		} >.github/workflows/pins.yml
		git add -A
		git commit -q -m pins
	)
	printf '%s\n' "$dir"
}

# --- case 2: synthetic repo, pins agree ----------------------------------------------------------
run_fixture_positive() {
	local dir out rc
	dir="$(build_fixture)"
	out="$(mktemp)"
	rc=0
	(
		cd "$dir"
		GITHUB_SHA="$(git rev-parse HEAD)" INPUT_CHECK_ONLY=true GITHUB_OUTPUT="$out" \
			bash "$SCRIPT"
	) || rc=$?
	rm -rf "$dir" "$out"
	if [ "$rc" -ne 0 ]; then
		echo "FAIL: synthetic fixture with agreeing pins should validate (rc=$rc)" >&2
		exit 1
	fi
	echo "PASS: synthetic fixture with agreeing uses: + executor pins validates"
}

# --- case 3: synthetic repo, executor pin bumped to a different valid ancestor -------------------
run_fixture_mismatch() {
	local dir out rc other
	dir="$(build_fixture)"
	out="$(mktemp)"
	rc=0
	(
		cd "$dir"
		# A second, distinct, still-valid ancestor SHA to point the executor pin at.
		other="$(git rev-parse HEAD)"
		sed -i -E "s/(github:knirski\/auto-pr#)[a-f0-9]{40}/\\1${other}/" .github/workflows/pins.yml
		git commit -qam mismatch
		GITHUB_SHA="$(git rev-parse HEAD)" INPUT_CHECK_ONLY=true GITHUB_OUTPUT="$out" \
			bash "$SCRIPT" >"$out.log" 2>&1
	) || rc=$?
	if [ "$rc" -eq 0 ]; then
		echo "FAIL: executor/uses SHA mismatch must be rejected, but check_only passed" >&2
		rm -rf "$dir" "$out" "$out.log"
		exit 1
	fi
	if ! grep -q 'exactly one 40-char SHA' "$out.log"; then
		echo "FAIL: mismatch failed but not via the uniform-SHA check; log was:" >&2
		cat "$out.log" >&2
		rm -rf "$dir" "$out" "$out.log"
		exit 1
	fi
	rm -rf "$dir" "$out" "$out.log"
	echo "PASS: executor/uses SHA mismatch rejected by uniform-SHA check (rc=$rc)"
}

run_real_tree_positive
run_fixture_positive
run_fixture_mismatch
echo "All update-pins check_only smoke cases passed."
