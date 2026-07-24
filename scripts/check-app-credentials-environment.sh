#!/usr/bin/env bash
# Live-repository settings check for the protected App-credentials environment (ADR 0016
# decisions 8-9). YAML/unit tests can prove a job DECLARES `environment: app-credentials`, but they
# CANNOT prove the live environment on GitHub is actually protected — only the GitHub API can.
#
# WHY THIS EXISTS (the auto-creation footgun): if a job references an environment that does not yet
# exist by that name in the repo, GitHub silently AUTO-CREATES it with NO protection rules on first
# reference — it does not error. A repo that wired up `environment: app-credentials` before creating
# a properly-restricted environment would therefore get an UNPROTECTED environment (all branches may
# deploy, secrets reachable from any ref), silently defeating the entire control. This script fails
# loudly when that has happened.
#
# WHAT IT ASSERTS (against the live GitHub API):
#   1. can_admins_bypass == false                         (admins cannot bypass the branch gate)
#   2. a custom deployment-branch policy exists           (NOT "all branches", NOT "protected only")
#   3. the branch-policy list is EXACTLY the default branch (no extra refs, no tag patterns)
#   4. environment secrets APP_ID and APP_PRIVATE_KEY exist (names only; GitHub never returns values)
#
# WHEN/HOW TO RUN (manual — NOT part of `bun test`/CI): this needs `gh auth` and network access to
# the real GitHub API with a token allowed to read environment config, so it cannot run in the
# sandboxed automated suite or in an untrusted PR's CI. Run it manually:
#   - BEFORE removing repository-level APP_ID/APP_PRIVATE_KEY secrets (confirm the environment-scoped
#     secrets are the ones actually gating access), and
#   - AFTER any change to the environment (branch policy, admin-bypass, secrets, default-branch
#     rename), which can silently weaken protection.
#
# USAGE:
#   scripts/check-app-credentials-environment.sh [REPO] [ENV_NAME]
#   REPO      defaults to knirski/auto-pr   (adopters: pass your own owner/name)
#   ENV_NAME  defaults to app-credentials
# Requires: gh (authenticated), jq. Exits non-zero on the first-through-last failing assertion.

set -euo pipefail

REPO="${1:-knirski/auto-pr}"
ENV_NAME="${2:-app-credentials}"

for cmd in gh jq; do
	if ! command -v "$cmd" >/dev/null 2>&1; then
		echo "ERROR: required command '$cmd' not found on PATH." >&2
		exit 2
	fi
done

echo "Checking protected environment '$ENV_NAME' on '$REPO'..."

fail=0
report_fail() {
	echo "  FAIL: $1" >&2
	fail=1
}
report_ok() {
	echo "  OK:   $1"
}

# Fetch the environment. A 404 here means it does not exist at all (never auto-created) — distinct
# from an existing-but-unprotected environment, which is the more dangerous silent case.
if ! env_json="$(gh api "repos/${REPO}/environments/${ENV_NAME}" 2>/dev/null)"; then
	echo "  FAIL: environment '${ENV_NAME}' does not exist on '${REPO}' (or it is not readable with" >&2
	echo "        the current gh token). Create it with a default-branch-only deployment policy" >&2
	echo "        BEFORE any workflow references it — see docs/INTEGRATION.md Step 5." >&2
	exit 1
fi

# 1. Admin bypass must be disabled.
if [ "$(jq -r '.can_admins_bypass' <<<"$env_json")" = "false" ]; then
	report_ok "can_admins_bypass is false"
else
	report_fail "can_admins_bypass is not false — administrators can bypass the branch gate (ADR 0016 decision 8)."
fi

# 2. A CUSTOM branch policy must be in force. A null deployment_branch_policy means "all branches"
#    (the silent auto-created default); protected_branches:true is the wrong kind of policy here
#    because the default branch may have no branch protection.
custom="$(jq -r '.deployment_branch_policy.custom_branch_policies // false' <<<"$env_json")"
protected="$(jq -r '.deployment_branch_policy.protected_branches // false' <<<"$env_json")"
if [ "$custom" = "true" ] && [ "$protected" = "false" ]; then
	report_ok "deployment branch policy is 'custom' (selected branches), not 'all' or 'protected only'"
else
	report_fail "deployment branch policy is not a custom/selected-branches policy (custom=${custom}, protected=${protected}); a null policy means ALL branches may deploy — the unprotected auto-created default."
fi

# 3. The custom policy's branch list must be EXACTLY the repository default branch.
default_branch="$(gh api "repos/${REPO}" --jq '.default_branch')"
policies_json="$(gh api "repos/${REPO}/environments/${ENV_NAME}/deployment-branch-policies" 2>/dev/null || echo '{}')"
# Sorted, newline-joined list of branch-type policy names (tag-type policies would show type=tag).
branch_names="$(jq -r '[.branch_policies[]? | select(.type == "branch") | .name] | sort | join(",")' <<<"$policies_json")"
all_names="$(jq -r '[.branch_policies[]?.name] | sort | join(",")' <<<"$policies_json")"
if [ "$branch_names" = "$default_branch" ] && [ "$all_names" = "$default_branch" ]; then
	report_ok "branch policy list is exactly the default branch ('${default_branch}')"
else
	report_fail "branch policy list is '${all_names:-<empty>}', expected exactly the default branch '${default_branch}' (extra refs or tag patterns weaken the gate)."
fi

# 4. Both App secrets must be present as ENVIRONMENT secrets (names only).
secrets_json="$(gh api "repos/${REPO}/environments/${ENV_NAME}/secrets" 2>/dev/null || echo '{}')"
for secret in APP_ID APP_PRIVATE_KEY; do
	if [ "$(jq -r --arg n "$secret" '[.secrets[]? | select(.name == $n)] | length' <<<"$secrets_json")" = "1" ]; then
		report_ok "environment secret '${secret}' is present"
	else
		report_fail "environment secret '${secret}' is missing from the '${ENV_NAME}' environment."
	fi
done

if [ "$fail" -ne 0 ]; then
	echo "" >&2
	echo "RESULT: '${ENV_NAME}' on '${REPO}' is NOT correctly protected. Do NOT rely on the" >&2
	echo "        environment gate (and do NOT remove repository-level App secrets) until fixed." >&2
	exit 1
fi

echo ""
echo "RESULT: '${ENV_NAME}' on '${REPO}' is correctly protected."
