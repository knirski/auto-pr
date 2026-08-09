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
# Requires: REPO, RUNNER, GITHUB_OUTPUT

set -euo pipefail

REPO="${REPO:?}"
RUNNER="${RUNNER:?}"
GITHUB_OUTPUT="${GITHUB_OUTPUT:?}"

# Use workspace only when the checked-out branch has both current workflow scripts and Bun.
# Older ai/** branches fall back to the stable published package.
workspace_ready=false
if [ "$REPO" = "knirski/auto-pr" ] && [ "$RUNNER" = "bunx" ] && [ -f package.json ] && jq -e '
  (.autoPr.workspaceCommands == "detached-head-v1") and
  (.scripts["build-model-routing-context"] | type == "string" and length > 0) and
  (.scripts["generate-content"] | type == "string" and length > 0)
' package.json >/dev/null 2>&1; then
	workspace_ready=true
fi

if [ "$workspace_ready" = "true" ]; then
	echo "use_workspace=true" >>"$GITHUB_OUTPUT"
else
	echo "use_workspace=false" >>"$GITHUB_OUTPUT"
fi
