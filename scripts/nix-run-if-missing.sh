#!/usr/bin/env bash
#
# Load-bearing: do not delete. Used broadly as a "run via PATH or fall back to nix run" helper:
#   - package.json: check:nix, check:docs, check:just-links, lint:scripts, format:scripts, lint:workflows
#   - lefthook pre-commit (shfmt -w on staged scripts)
#   - scripts/act-local-ci.ts (planActRun direct backend: bash + this script + act)
#   - knip.json ignoreBinaries (avoids false-positive unused)
#
# The 2026-04-19 CI audit (Area E, spec §5) considered removing this in favor of gh act alone; investigation
# showed many non-act callers. This shim is general-purpose tool-fallback infrastructure.
#
# Run a tool from PATH or via nix run .#<tool> (flake packages).
#
# Usage: nix-run-if-missing.sh [--optional] <tool> [args...]
#
#   Required (default): Run <tool> with [args...]. Fail if neither tool nor nix is available.
#   Optional (--optional): Same, but skip (exit 0) when neither tool nor nix is available.
#
# Examples:
#   nix-run-if-missing.sh typos
#   nix-run-if-missing.sh statix check .
#   nix-run-if-missing.sh --optional statix check .   # skip when nix unavailable

set -euo pipefail

optional=false
if [[ "${1:-}" == "--optional" ]]; then
	optional=true
	shift
fi

tool="${1:?Usage: nix-run-if-missing.sh [--optional] <tool> [args...]}"
shift

if command -v "$tool" >/dev/null 2>&1; then
	exec "$tool" "$@"
elif command -v nix >/dev/null 2>&1; then
	exec nix run --extra-experimental-features 'nix-command flakes' --option warn-dirty false ".#$tool" -- "$@"
elif [[ "$optional" == true ]]; then
	exit 0
else
	echo "error: $tool not in PATH and nix not available" >&2
	exit 1
fi
