# OpenSSF Scorecard Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Increase the OpenSSF Scorecard from 6/10 to 8-9/10 by fixing Token-Permissions and updating documentation.

**Architecture:** Four workflow files need write permissions moved from workflow-level to job-level. Documentation updates capture manual steps (GitHub settings, CII badge) and future work (Signed-Releases, Fuzzing, Packaging). No application code changes.

**Tech Stack:** GitHub Actions YAML, Markdown

**Spec:** `docs/superpowers/specs/2026-04-02-openssf-scorecard-improvements-design.md`

---

### Task 1: Fix Token-Permissions in `add-dist-to-release-pr.yml`

**Files:**
- Modify: `.github/workflows/add-dist-to-release-pr.yml:21-23` and `:25-27`

- [ ] **Step 1: Move write permissions from workflow-level to job-level**

Replace the workflow-level permissions block (lines 21-23) with `permissions: {}`, and add job-level permissions to the `add-dist` job:

Before:
```yaml
permissions:
  contents: write
  pull-requests: read

jobs:
  add-dist:
    if: github.event.pull_request.head.repo.full_name == github.repository
```

After:
```yaml
permissions: {}

jobs:
  add-dist:
    if: github.event.pull_request.head.repo.full_name == github.repository
    permissions:
      contents: write
      pull-requests: read
```

- [ ] **Step 2: Validate the workflow syntax**

Run: `actionlint .github/workflows/add-dist-to-release-pr.yml`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/add-dist-to-release-pr.yml
git commit -m "fix(ci): move write permissions to job-level in add-dist-to-release-pr"
```

---

### Task 2: Fix Token-Permissions in `stale.yml`

**Files:**
- Modify: `.github/workflows/stale.yml:13-15` and `:17-19`

- [ ] **Step 1: Move write permissions from workflow-level to job-level**

Replace the workflow-level permissions block (lines 13-15) with `permissions: {}`, and add job-level permissions to the `stale` job:

Before:
```yaml
permissions:
  issues: write
  pull-requests: write

jobs:
  stale:
    runs-on: ubuntu-24.04
```

After:
```yaml
permissions: {}

jobs:
  stale:
    permissions:
      issues: write
      pull-requests: write
    runs-on: ubuntu-24.04
```

- [ ] **Step 2: Validate the workflow syntax**

Run: `actionlint .github/workflows/stale.yml`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/stale.yml
git commit -m "fix(ci): move write permissions to job-level in stale"
```

---

### Task 3: Fix Token-Permissions in `auto-pr.yml`

**Files:**
- Modify: `.github/workflows/auto-pr.yml:14-18` and `:29-44`

This workflow calls two reusable workflows. Caller workflow permissions cap nested reusable workflows, so each calling job must declare the permissions its callee needs.

- [ ] **Step 1: Replace workflow-level permissions with `permissions: {}` and add job-level permissions**

Before:
```yaml
permissions:
  contents: read
  models: read # required for reusable generate job (GitHub Models); caller caps nested permissions
  pull-requests: write

on:
  push:
    branches:
      - "ai/**"

concurrency:
  group: auto-pr-${{ github.ref }}
  cancel-in-progress: true

jobs:
  generate:
    if: github.ref_name != github.event.repository.default_branch
    uses: knirski/auto-pr/.github/workflows/auto-pr-generate-reusable.yml@e7a7fa9ff40e0b0e9102ef0bdb9de34d28ab6941
    secrets:
      # GitHub API token for the generate job. This workflow grants `models: read` so the default
      # `github.token` works. If you use a PAT, set repo secret `GH_TOKEN` and pass
      # `${{ secrets.GH_TOKEN || github.token }}` here instead.
      GH_TOKEN: ${{ github.token }}

  create:
    needs: generate
    uses: knirski/auto-pr/.github/workflows/auto-pr-create-reusable.yml@e7a7fa9ff40e0b0e9102ef0bdb9de34d28ab6941
    with:
      auto_pr_pkg: ${{ needs.generate.outputs.auto_pr_pkg }}
    secrets: inherit
```

After:
```yaml
permissions: {}

on:
  push:
    branches:
      - "ai/**"

concurrency:
  group: auto-pr-${{ github.ref }}
  cancel-in-progress: true

jobs:
  generate:
    if: github.ref_name != github.event.repository.default_branch
    permissions:
      contents: read
      models: read # required for reusable generate job (GitHub Models); caller caps nested permissions
    uses: knirski/auto-pr/.github/workflows/auto-pr-generate-reusable.yml@e7a7fa9ff40e0b0e9102ef0bdb9de34d28ab6941
    secrets:
      # GitHub API token for the generate job. This workflow grants `models: read` so the default
      # `github.token` works. If you use a PAT, set repo secret `GH_TOKEN` and pass
      # `${{ secrets.GH_TOKEN || github.token }}` here instead.
      GH_TOKEN: ${{ github.token }}

  create:
    needs: generate
    permissions:
      contents: read
      pull-requests: write
    uses: knirski/auto-pr/.github/workflows/auto-pr-create-reusable.yml@e7a7fa9ff40e0b0e9102ef0bdb9de34d28ab6941
    with:
      auto_pr_pkg: ${{ needs.generate.outputs.auto_pr_pkg }}
    secrets: inherit
```

- [ ] **Step 2: Validate the workflow syntax**

Run: `actionlint .github/workflows/auto-pr.yml`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/auto-pr.yml
git commit -m "fix(ci): move write permissions to job-level in auto-pr"
```

---

### Task 4: Fix Token-Permissions in `auto-pr-create-reusable.yml`

**Files:**
- Modify: `.github/workflows/auto-pr-create-reusable.yml:18-20`

The job at line 24 already has `permissions: contents: read, pull-requests: write`. Only the workflow-level block needs to change.

- [ ] **Step 1: Replace workflow-level permissions with `permissions: {}`**

Before:
```yaml
permissions:
  contents: read
  pull-requests: write
```

After:
```yaml
permissions: {}
```

- [ ] **Step 2: Validate the workflow syntax**

Run: `actionlint .github/workflows/auto-pr-create-reusable.yml`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/auto-pr-create-reusable.yml
git commit -m "fix(ci): move write permissions to job-level in auto-pr-create-reusable"
```

---

### Task 5: Update `docs/CII.md` with scorecard context

**Files:**
- Modify: `docs/CII.md`

- [ ] **Step 1: Update CII.md to reflect current scorecard status and next steps**

Replace the full contents of `docs/CII.md` with:

```markdown
# CII Best Practices Badge — Progress

This project pursues the [OpenSSF Best Practices badge](https://www.bestpractices.dev/en) (formerly CII). Self-certify at [bestpractices.dev](https://www.bestpractices.dev/en/projects/new).

## Implemented

| Criterion area | Status | Notes |
|----------------|--------|-------|
| **Dependency management** | Done | bun audit in check script; Dependabot for Bun and GitHub Actions |
| **Static analysis** | Done | CodeQL (security-extended); Biome |
| **SBOM** | Done | CycloneDX SBOM via native npm sbom in CI; artifact per run |
| **Token permissions** | Done | All workflows use `permissions: {}` at workflow-level; write permissions at job-level only |
| **Pinned actions** | Done | All workflow actions pinned by full commit hash |
| **Vulnerability reporting** | Done | SECURITY.md; GitHub Private Vulnerability Reporting |

## Next steps

- Register at bestpractices.dev and complete self-assessment
- Add badge to README.md once registered
- Signed releases with SLSA provenance (when publishing to npm)
- Fuzzing with ClusterFuzzLite + Jazzer.js (when input parsing complexity warrants it)
```

- [ ] **Step 2: Commit**

```bash
git add docs/CII.md
git commit -m "docs: update CII.md with current scorecard status"
```

---

### Task 6: Verify all workflows pass linting

**Files:**
- None (verification only)

- [ ] **Step 1: Run actionlint on all modified workflows**

Run: `actionlint .github/workflows/add-dist-to-release-pr.yml .github/workflows/stale.yml .github/workflows/auto-pr.yml .github/workflows/auto-pr-create-reusable.yml`
Expected: No errors.

- [ ] **Step 2: Run the full check suite**

Run: `bun run check`
Expected: All checks pass. This runs biome, knip, tsgo, tests, and actionlint.
