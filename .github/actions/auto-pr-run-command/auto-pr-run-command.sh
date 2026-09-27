#!/usr/bin/env bash
# Run auto-pr command from workspace or package.
# Usage: auto-pr-run-command.sh <build-model-routing-context|generate-content>
# Requires: USE_WORKSPACE, AUTO_PR_PKG, RUNNER (for package mode)

set -euo pipefail

CMD="${1:?Usage: auto-pr-run-command.sh <build-model-routing-context|generate-content>}"
USE_WORKSPACE="${USE_WORKSPACE:?}"
AUTO_PR_PKG="${AUTO_PR_PKG:?}"
RUNNER="${RUNNER:?}"
TRUSTED_PACKAGE_REQUIRED="${TRUSTED_PACKAGE_REQUIRED:-false}"

# Fail closed when a step carries a long-lived inference secret: branch-controlled workspace
# code must never run next to the key, and the package ref must be immutable (40-char SHA).
if [ "$TRUSTED_PACKAGE_REQUIRED" = "true" ]; then
	if [ "$USE_WORKSPACE" != "false" ]; then
		echo "::error::Trusted package mode is required for secret-bearing OpenRouter steps"
		exit 1
	fi
	if ! printf '%s' "$AUTO_PR_PKG" | grep -Eq '^github:knirski/auto-pr#[0-9a-f]{40}$'; then
		echo "::error::AUTO_PR_PKG must be pinned to a 40-character SHA when trusted package mode is required"
		exit 1
	fi
fi

case "$CMD" in
build-model-routing-context)
	BIN="auto-pr-build-model-routing-context"
	SCRIPT="build-model-routing-context"
	;;
generate-content)
	BIN="auto-pr-generate-content"
	SCRIPT="generate-content"
	;;
*)
	echo "::error::Unknown command: $CMD"
	exit 1
	;;
esac

if [ "$USE_WORKSPACE" = "true" ] && [ "$RUNNER" = "bunx" ]; then
	bun run "$SCRIPT"
else
	"$RUNNER" -p "$AUTO_PR_PKG" "$BIN"
fi
