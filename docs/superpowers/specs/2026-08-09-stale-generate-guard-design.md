# Stale Auto-PR Generate Guard (Design)

**Date:** 2026-08-09
**Scope:** Prevent queued or manually triggered Auto-PR generation jobs from failing on stale `ai/**` branches.

## Goal

Make stale branch handling safe at the point of execution, not only during scheduled discovery. A generation run should finish successfully as a deliberate skip when its branch is deleted, stale, or associated with a closed, merged, or open pull request.

## Design

Add a read-only validation step to `.github/workflows/auto-pr-generate-reusable.yml`, before checkout and before any package or source code is executed. The caller supplies `source_branch` and the immutable `head_sha` already resolved by discovery. Generated and skipped outcomes are uploaded intentionally under `pr-content-<head_sha>`, so matrix jobs cannot collide on a shared artifact name.

The validation checks the repository API for:

1. The requested branch still exists.
2. The branch tip still equals `head_sha`.
3. The branch tip is newer than the 30-day abandonment cutoff.
4. No pull request in any state has the requested branch as its head.

If validation fails, the job writes a skip output and exits with status zero. Checkout, package execution, generation, and model/container work are conditional on the validation output. Artifact preparation and upload are intentionally not conditional: a skipped branch publishes an empty-content manifest with `status: skipped`, allowing the create phase to stop before Bun setup, App-secret reads, token minting, or PR writes.

The existing scheduled-discovery filter remains in place as an efficiency optimization. PR association requires both the `head.ref` match and `head.repo.full_name` equal to the current repository, so a fork PR using the same branch name does not suppress a same-repository source branch.

The privileged `workflow_run` ingress does not use `workflow_run.head_branch` or `workflow_run.head_sha` as source identity: scheduled and manual generate runs execute from the default branch, and those ambient fields therefore identify `main`, not each matrix source. Instead, the ingress enumerates SHA-qualified PR-content artifacts from the exact triggering run and fans out one reusable create call per exact artifact name. The reusable create workflow validates the selected artifact name and manifest repository, `ai/**` branch, default branch, head SHA, file set, and content digests. It then uses the validated manifest branch/SHA for live branch-tip re-resolution before privileged work.

## API and permissions

Use the existing repository `GH_TOKEN` with `contents: read` and `pull-requests: read`. Do not add write permissions, checkout the branch, or execute branch-controlled code before validation. Treat API lookup failures as real workflow failures; only a confirmed stale/deleted/PR-associated branch is a successful skip.

## Testing

Extend workflow tests with representative validation inputs for:

- a fresh branch with no PR — generation proceeds;
- a branch older than 30 days — generation skips;
- a deleted branch or mismatched tip — generation skips;
- a branch with an open, closed, or merged PR — generation skips.

Add structural regressions for immutable artifact names, exact-run artifact enumeration and create fanout, manifest-derived scheduled identity, skipped-manifest early exit, and same-repository PR matching.

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
- Every triggering-run artifact is selected explicitly and processed with manifest-derived identity.
- `bun run check` passes.
