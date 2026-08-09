# Stale Workspace Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent outdated same-repository AI branches from running their stale workspace source during generation.

**Architecture:** Add an explicit capability marker to the package manifest. The composite selector will require the marker, same-repository Bun, and both command scripts before selecting workspace mode; otherwise it will select the published package, which contains the detached-HEAD fix. Extend the shell-action tests to cover both stale and current manifests.

**Tech Stack:** Bash, jq, GitHub composite actions, Bun, Bun test.

## Global Constraints

- Use Bun for tests and checks.
- Preserve the unprivileged workspace/package boundary; do not reintroduce branch-derived package references.
- Do not commit generated `dist/` output.
- Follow conventional commits and keep workflow self-references pinned to a full SHA.

---

### Task 1: Add regression coverage for capability-gated workspace selection

**Files:**
- Test: `test/scripts/auto-pr-workflow.test.ts`

**Interfaces:**
- Consumes the existing `runSetPackageAction` test helper.
- Produces tests proving manifests without the marker select package mode and manifests with the marker select workspace mode.

- [ ] **Step 1: Write the failing test**

Add a test that supplies both existing scripts but no capability marker and expects `use_workspace=false`. Update the positive test manifest with the marker and keep its `use_workspace=true` assertion.

- [ ] **Step 2: Run the focused test**

Run: `bun test test/scripts/auto-pr-workflow.test.ts`

Expected: the new stale-manifest test fails because the current selector only checks the scripts.

- [ ] **Step 3: Commit the regression test**

Run: `git add test/scripts/auto-pr-workflow.test.ts && git commit -m "test: gate workspace mode on capability marker"`

### Task 2: Implement capability-gated package selection

**Files:**
- Modify: `package.json`
- Modify: `.github/actions/auto-pr-set-pkg/auto-pr-set-pkg.sh`
- Modify: `test/scripts/auto-pr-workflow.test.ts`

**Interfaces:**
- Consumes `package.json` field `autoPr.workspaceCommands` with value `detached-head-v1`.
- Produces `use_workspace=true` only when that exact capability marker and the existing command/runtime checks pass.

- [ ] **Step 1: Add the marker and jq predicate**

Add `"autoPr": { "workspaceCommands": "detached-head-v1" }` to `package.json`. Extend the action’s jq expression with `(.autoPr.workspaceCommands == "detached-head-v1")`.

- [ ] **Step 2: Run focused tests**

Run: `bun test test/scripts/auto-pr-workflow.test.ts`

Expected: all workflow-selection tests pass.

- [ ] **Step 3: Run shell syntax and diff checks**

Run: `bash -n .github/actions/auto-pr-set-pkg/auto-pr-set-pkg.sh && git diff --check`

Expected: exit code 0.

- [ ] **Step 4: Commit the implementation**

Run: `git add package.json .github/actions/auto-pr-set-pkg/auto-pr-set-pkg.sh test/scripts/auto-pr-workflow.test.ts && git commit -m "fix: avoid stale workspace commands on old branches"`

### Task 3: Pin the workflow reference and verify the branch

**Files:**
- Modify: `.github/workflows/auto-pr-generate-reusable.yml`
- Modify: `.github/workflows/auto-pr-create-reusable.yml` if its selector self-reference is stale

**Interfaces:**
- Consumes the updated selector action at the current branch SHA.
- Produces workflows that can deliver the selector fix when the scheduled workflow runs from `main`.

- [ ] **Step 1: Update self-references**

Replace selector/action self-references with the branch’s current full 40-character SHA, preserving third-party pins and same-repository local references.

- [ ] **Step 2: Run repository verification**

Run: `bun run check`

Expected: all checks pass; if the known Biome schema/version or unrelated formatting failures recur, record their exact output and continue only with those pre-existing failures documented.

- [ ] **Step 3: Review and commit**

Run: `git diff --check && git status --short && git commit -am "fix: route stale branches to published auto-pr"`

Expected: only the intended selector, marker, test, plan, and workflow-pin files are changed; no `dist/` files are committed.
