#!/usr/bin/env sh
# Prevent committing dist/ - CI updates it on main after merge.
set -e
if git diff --cached --name-only --diff-filter=ACMR | grep -q '^dist/'; then
	echo "Do not commit dist/. Restore with: git restore --staged dist/"
	exit 1
fi
