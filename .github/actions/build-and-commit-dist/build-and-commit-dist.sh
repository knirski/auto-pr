#!/usr/bin/env bash
# Commit dist/ (git add -f) and push to PUSH_BRANCH with fetch/rebase/retry.
# Expects: GH_TOKEN, PUSH_BRANCH; uses GITHUB_REPOSITORY (Actions default env).

set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${PUSH_BRANCH:?PUSH_BRANCH is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git remote set-url origin "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
git add -f dist/
if git diff --staged --quiet; then
	exit 0
fi
git commit -m "chore: update dist"

# Shallow clones may lack history for merge-base / rebase; deepen once before rebasing.
if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
	git fetch --unshallow 2>/dev/null || {
		d=0
		while [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ] && [ "$d" -lt 12 ]; do
			git fetch --deepen=50 origin "$PUSH_BRANCH" || break
			d=$((d + 1))
		done
	}
fi

remote_ref="origin/${PUSH_BRANCH}"
max_attempts=5
attempt=1
while [ "$attempt" -le "$max_attempts" ]; do
	git fetch origin "$PUSH_BRANCH"
	if ! git rebase "$remote_ref"; then
		echo "::error::git rebase onto ${remote_ref} failed (resolve conflicts locally if this persists)"
		exit 1
	fi
	if git push origin "HEAD:${PUSH_BRANCH}"; then
		exit 0
	fi
	echo "Push rejected (attempt ${attempt}/${max_attempts}); remote may have advanced — retrying..."
	attempt=$((attempt + 1))
	sleep $((attempt * 2))
done
echo "::error::git push failed after ${max_attempts} attempts"
exit 1
