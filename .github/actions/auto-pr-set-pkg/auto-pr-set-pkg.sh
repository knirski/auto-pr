#!/usr/bin/env bash
# Determine whether auto-pr runs from the same-repo workspace or a published package.
# Outputs `use_workspace` to GITHUB_OUTPUT.
#
# Purely informational: `use_workspace` controls only how the UNPRIVILEGED generate job invokes
# its OWN commands (bun run from the workspace vs `npx` a published package). It does NOT select
# what code any PRIVILEGED job runs. The branch-derived package ref
# (github:knirski/auto-pr#<branch>) that this script used to emit was removed because it was an
# attacker-influenceable install target for the privileged create job (ADR 0016 decisions 3, 6).
#
# Requires: REPO, GITHUB_OUTPUT

set -euo pipefail

REPO="${REPO:?}"
GITHUB_OUTPUT="${GITHUB_OUTPUT:?}"

# Use workspace when running in the auto-pr source repo: avoids "Package does not provide binary"
# when dist/ is gitignored. Adopter repos run the published package via npx/bunx instead.
if [ "$REPO" = "knirski/auto-pr" ]; then
	echo "use_workspace=true" >>"$GITHUB_OUTPUT"
else
	echo "use_workspace=false" >>"$GITHUB_OUTPUT"
fi
