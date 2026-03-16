#!/usr/bin/env bash
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
	exec nix run --option warn-dirty false ".#$tool" -- "$@"
elif [[ "$optional" == true ]]; then
	exit 0
else
	echo "error: $tool not in PATH and nix not available" >&2
	exit 1
fi
