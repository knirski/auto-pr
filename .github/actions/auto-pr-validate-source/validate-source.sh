#!/usr/bin/env bash
# Validate an Auto-PR source branch before checkout or branch-controlled execution.

set -euo pipefail

: "${EXPECTED_SHA:?}"
: "${GITHUB_OUTPUT:?}"
: "${GH_TOKEN:?}"
: "${REPO:?}"
: "${SOURCE_BRANCH:?}"

if [[ "$SOURCE_BRANCH" != ai/* ]]; then
	echo "::error::source_branch must start with ai/."
	exit 1
fi

branch_error=$(mktemp)
trap 'rm -f "$branch_error"' EXIT
encoded_source_branch=$(jq -rn --arg branch "$SOURCE_BRANCH" '$branch | @uri')
if ! branch_ref=$(gh api "repos/$REPO/git/ref/heads/$encoded_source_branch" 2>"$branch_error"); then
	if grep -q 'HTTP 404' "$branch_error"; then
		echo "Skipping generation: source branch no longer exists."
		echo "skip=true" >>"$GITHUB_OUTPUT"
		exit 0
	fi
	cat "$branch_error" >&2
	exit 1
fi

current_sha=$(printf '%s' "$branch_ref" | jq -er '.object.sha')
committed_at=$(gh api "repos/$REPO/commits/$current_sha" | jq -er '.commit.committer.date')
date -u -d "$committed_at" +%s >/dev/null
cutoff=$(date -u -d '30 days ago' '+%Y-%m-%dT%H:%M:%SZ')
all_pr_heads=$(gh api --paginate "repos/$REPO/pulls?state=all&per_page=100" | jq -s --arg source_branch "$SOURCE_BRANCH" --arg repo "$REPO" '
	if all(.[]; type == "array") and all(.[][];
		(.head? | type == "object")
		and (.head.ref? | type == "string")
		and ((.head.repo? == null) or ((.head.repo? | type == "object") and (.head.repo.full_name? | type == "string")))
	) then
		any(.[][]; .head.ref == $source_branch and .head.repo.full_name? == $repo)
	else
		error("malformed pull request API response")
	end
')

if [ "$current_sha" != "$EXPECTED_SHA" ]; then
	echo "Skipping generation: source branch tip has changed."
	echo "skip=true" >>"$GITHUB_OUTPUT"
elif [[ "$committed_at" < "$cutoff" ]]; then
	echo "Skipping generation: source branch commit is older than 30 days."
	echo "skip=true" >>"$GITHUB_OUTPUT"
elif [ "$all_pr_heads" = "true" ]; then
	echo "Skipping generation: source branch already has a pull request."
	echo "skip=true" >>"$GITHUB_OUTPUT"
else
	echo "skip=false" >>"$GITHUB_OUTPUT"
fi
