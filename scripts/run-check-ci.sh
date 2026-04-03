#!/usr/bin/env bash
# Run the CI `check` job locally via gh act or act (not the `integration` job). Requires Docker.
# act: PATH, or `nix run .#act` / dev shell when Nix is available (see scripts/nix-run-if-missing.sh).
# Usage: run-check-ci.sh

set -euo pipefail

_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_repo_root="$(cd "$_script_dir/.." && pwd)"
cd "$_repo_root"

ci_workflow=".github/workflows/ci.yml"
ci_event="workflow_dispatch"
ci_job="check"

run_gh_act() {
	gh act -W "$ci_workflow" "$ci_event" -j "$ci_job"
}

run_act() {
	"$_script_dir/nix-run-if-missing.sh" act -W "$ci_workflow" "$ci_event" -j "$ci_job"
}

run_gh_act || run_act || {
	echo ""
	echo "check:ci failed. To run CI locally, install:"
	echo "  - Docker: https://docs.docker.com/get-docker/"
	echo "  - gh act: gh extension install nektos/gh-act"
	echo "  - or act:  brew install act (https://github.com/nektos/act#installation)"
	echo "  - or Nix: nix run .#act -- ...  (act is in this flake; see CONTRIBUTING.md)"
	exit 1
}
