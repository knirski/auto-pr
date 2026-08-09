# Stale Auto-PR Generate Guard (Design)

**Date:** 2026-08-09  
**Scope:** Prevent queued or manually triggered Auto-PR generation jobs from failing on stale `ai/**` branches.

## Goal

Make stale branch handling safe at the point of execution, not only during scheduled discovery. A generation run should finish successfully as a deliberate skip when its branch is deleted, stale, or associated with a closed, merged, or open pull request.

## Design

Add a read-only validation step to `.github/workflows/auto-pr-generate-reusable.yml`, before checkout and before any package or source code is executed. The caller supplies `source_branch` and the immutable `head_sha` already resolved by discovery.

The validation checks the repository API for:

1. The requested branch still exists.
2. The branch tip still equals `head_sha`.
3. The branch tip is newer than the 30-day abandonment cutoff.
4. No pull request in any state has the requested branch as its head.

If validation fails, the job writes a skip output and exits with status zero. Generation, artifact upload, and downstream content work are conditional on the validation output. A skipped branch therefore does not create a failing check or consume model/container work.

The existing scheduled-discovery filter remains in place as an efficiency optimization. The reusable-workflow guard is the correctness boundary for scheduled runs that were already queued and for manual invocations.

## API and permissions

Use the existing repository `GH_TOKEN` with `contents: read` and `pull-requests: read`. Do not add write permissions, checkout the branch, or execute branch-controlled code before validation. Treat API lookup failures as real workflow failures; only a confirmed stale/deleted/PR-associated branch is a successful skip.

## Testing

Extend workflow tests with representative validation inputs for:

- a fresh branch with no PR — generation proceeds;
- a branch older than 30 days — generation skips;
- a deleted branch or mismatched tip — generation skips;
- a branch with an open, closed, or merged PR — generation skips.

Retain the existing scheduled-discovery tests to ensure filtering continues to avoid unnecessary matrix entries.

## Alternatives considered

- **Discovery filtering only:** smaller change, but cannot stop jobs queued before discovery or protect direct/manual invocations.
- **Branch/PR validation without freshness checking:** protects PR-associated branches but still permits abandoned branches without PRs to run indefinitely.
- **Execution-time validation guard (selected):** adds one read-only boundary and protects every invocation while preserving manual revival only when the branch is intentionally current and unassociated with a PR.

## Success criteria

- Stale, deleted, tip-mismatched, and PR-associated branches produce successful skips.
- Current unassociated branches continue through generation.
- No branch-controlled code runs before validation.
- Existing permissions remain read-only.
- `bun run check` passes.
