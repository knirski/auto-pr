# Stale Auto-PR Generate Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every Auto-PR generation invocation skip stale, deleted, tip-mismatched, or PR-associated `ai/**` branches successfully before checkout or branch-controlled execution.

**Architecture:** Add a read-only `Validate source branch` step as the first step in the reusable generate job. It queries the branch tip and same-repository PR head refs, writes `skip=true/false` to `GITHUB_OUTPUT`, and fails only on API or validation errors that cannot establish branch state. Expensive generate steps become conditional on the validation result, while artifact preparation and upload remain intentional so every source commit produces either generated content or a skipped marker. The privileged `workflow_run` ingress enumerates those immutable, SHA-qualified artifacts from the exact run and derives source identity from each validated manifest rather than ambient workflow-run branch/SHA fields.

**Tech Stack:** GitHub Actions YAML, `gh api`, `jq`, Bash, Bun tests, actionlint.

## Global Constraints

- Do not checkout or execute branch-controlled code before stale-branch validation.
- Keep workflow permissions read-only: `contents: read`, `pull-requests: read`, and existing `models: read` only.
- A confirmed stale, deleted, tip-mismatched, or PR-associated branch exits successfully and reports a deliberate skip.
- API failures remain workflow failures; do not convert authentication or transport errors into skips.
- Preserve the existing scheduled-discovery filter and manual-dispatch behavior.
- Upload intentionally skipped manifests under a source-commit-qualified artifact name.
- Use full 40-character SHA pins for self-referenced reusable actions/workflows.
- Run `bun run check` before completion and do not commit generated `dist/` output.

---

### Task 1: Add failing workflow guard assertions

**Files:**
- Modify: `test/scripts/auto-pr-workflow.test.ts`

**Interfaces:**
- Consumes: `.github/workflows/auto-pr-generate-reusable.yml` source text.
- Produces: regression assertions that require validation before checkout and gate generation on validation output.

- [ ] **Step 1: Write the failing tests**

Add a test that reads the reusable workflow and asserts it contains:

```typescript
test("validates source branches before checkout and generation", () => {
  const generateWorkflow = readFileSync(
    join(repoRoot, ".github/workflows/auto-pr-generate-reusable.yml"),
    "utf8",
  );

  expect(generateWorkflow).toContain("Validate source branch");
  expect(generateWorkflow).toContain("pulls?state=all&per_page=100");
  expect(generateWorkflow).toContain("30 days ago");
  expect(generateWorkflow).toContain("source_branch");
  expect(generateWorkflow).toContain("head_sha");
  expect(generateWorkflow).toContain("steps.validate.outputs.skip != 'true'");
  expect(generateWorkflow.indexOf("Validate source branch")).toBeLessThan(
    generateWorkflow.indexOf("Checkout branch"),
  );
});
```

Also assert representative existing work steps are gated:

```typescript
expect(generateWorkflow).toContain("if: steps.validate.outputs.skip != 'true'");
expect(generateWorkflow).toContain(
  "if: steps.validate.outputs.skip != 'true' && steps.semantic.outputs.should_create_pr == 'true'",
);
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `bun test test/scripts/auto-pr-workflow.test.ts`

Expected: FAIL because the reusable workflow has no `validate` step or skip conditions yet.

- [ ] **Step 3: Commit the failing test**

```bash
git add test/scripts/auto-pr-workflow.test.ts
git commit -m "test: specify stale generate guard"
```

### Task 2: Implement execution-time branch validation

**Files:**
- Modify: `.github/workflows/auto-pr-generate-reusable.yml`

**Interfaces:**
- Consumes: `inputs.source_branch`, `inputs.head_sha`, `github.repository`, `github.event.repository.default_branch`, and the existing job token.
- Produces: step `validate` output `skip`, where `true` means successful deliberate skip and `false` permits generation.

- [ ] **Step 1: Add the validation step before checkout**

Add the first job step with `id: validate` and environment variables for `GH_TOKEN`, `REPO`, `SOURCE_BRANCH`, and `EXPECTED_SHA`. Validate the branch name starts with `ai/`; otherwise fail because the reusable contract is invalid. Fetch the branch with `gh api` and capture its current SHA and commit timestamp. Query all PR head refs with `state=all` and `per_page=100`.

Use a 30-day UTC cutoff and skip when any of these are true:

```bash
branch is absent
current_sha != EXPECTED_SHA
committed_at < cutoff
SOURCE_BRANCH appears in all_pr_heads
```

For each confirmed skip, print a neutral explanation and append `skip=true` to `$GITHUB_OUTPUT`. For a valid branch, append `skip=false`. Let failed `gh api`, `jq`, or malformed API data terminate the step with a non-zero status.

- [ ] **Step 2: Gate checkout and all generation work**

Add `if: steps.validate.outputs.skip != 'true'` to checkout, prerequisites, setup, fetch, package installation, commit counting, semantic detection, and routing. For steps already guarded by semantic-generation conditions, combine them with the validation condition, for example:

```yaml
if: steps.validate.outputs.skip != 'true' && steps.semantic.outputs.should_create_pr == 'true'
```

Keep local llama cleanup guarded by `always()` and its existing outcome check so a future failure after validation still stops the container. A stale skip must not start that container.

Keep artifact preparation and upload unconditional. They intentionally publish a skipped manifest for a confirmed stale/deleted/PR-associated source so the run-scoped create fanout can consume a complete outcome without starting Bun, reading App secrets, minting a token, or writing a PR.

- [ ] **Step 3: Run the focused tests and workflow linter**

Run: `bun test test/scripts/auto-pr-workflow.test.ts`

Expected: PASS with the new guard assertions.

Run: `bun run lint:workflows`

Expected: PASS with no workflow syntax errors.

- [ ] **Step 4: Commit the implementation**

```bash
git add .github/workflows/auto-pr-generate-reusable.yml
git commit -m "fix: skip stale auto-pr generation runs"
```

### Task 3: Verify the complete change and prepare the PR

**Files:**
- Verify: `.github/workflows/auto-pr-generate-reusable.yml`
- Verify: `test/scripts/auto-pr-workflow.test.ts`
- Verify: `docs/superpowers/specs/2026-08-09-stale-generate-guard-design.md`
- Verify: `docs/superpowers/plans/2026-08-09-stale-generate-guard.md`

**Interfaces:**
- Consumes: the implementation and regression test from Tasks 1–2.
- Produces: a verified branch ready for a pull request against `main`.

- [ ] **Step 1: Run the full project check**

Run: `bun run check`

Expected: exit 0, with no test failures or lint/type/workflow errors. If verification regenerates `dist/`, restore only those generated files before committing or pushing.

- [ ] **Step 2: Run the final diff checks**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors, only intentional source/test/spec/plan changes, and no generated `dist/` changes.

- [ ] **Step 3: Push the branch**

```bash
git push -u origin ai/guard-stale-generate
```

Expected: branch is published without force-pushing.

- [ ] **Step 4: Create the pull request**

Create a PR against `main` with:

- Title: `fix: skip stale auto-pr generation runs`
- Body summary: queued and manual generation runs now validate branch existence, immutable tip, freshness, and all-state PR association before checkout; confirmed stale branches skip successfully; API errors still fail visibly.
- Tests: `bun run check`.

- [ ] **Step 5: Report the PR URL and CI status**

Use `gh pr checks` as the source of truth. Report the PR URL, commit, and whether checks are passing or still pending; do not claim completion without fresh verification output.
