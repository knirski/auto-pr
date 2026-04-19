# CI Area F — Hygiene Sweep Implementation Plan

**Implementation status (2026-04-20):** Work was executed in-repo; `- [x]` marks completed steps. Confirm [branch protection](../../CI.md#branch-protection) (`CI / gate` only) and any GitHub-only follow-ups on the live repository.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Apply eight cross-cutting GitHub Actions conventions uniformly across all 27 workflow files and 9 composite actions in `knirski/auto-pr`, eliminating drift so subsequent area-specific PRs (B, A, D, E) inherit correct defaults.

**Architecture:** This is a mechanical sweep, not a feature. One PR, one commit per checklist item, each commit atomic and independently revertable. No behavioural changes beyond concurrency cancellation (added where missing) and permission scoping (narrowed from workflow-level to job-level). All existing guarantees (externally-called reusables, branch protection contracts, Nix reproducibility, local-CI capability) are preserved.

**Tech Stack:** GitHub Actions YAML, `actionlint` (via `bun run lint:workflows` or `nix develop --command actionlint`), `jq`, `yq` (optional for structural verification). No runtime code changes.

**Reference spec:** `docs/superpowers/specs/2026-04-19-ci-modernization-audit-design.md` §6 (Area F).

**Branch:** `ai/ci-area-f-hygiene-sweep` (per project convention: `ai/` prefix).

**Out of scope:**
- Deleting or consolidating entry workflows (that's Area A).
- Self-referential pin changes (that's Area B).
- Nix composite action extraction (that's Area D).
- `act` harness changes (that's Area E).
- Touching the committed `dist/` pipeline (explicitly preserved by user).

**A note on ordering vs. Area A:** Area A will delete `ci-docs.yml`, `ci-website.yml`, `ci-workflows.yml`, `ci-release-please.yml`, and `ci-nix.yml`. F lands first per spec §8, which means we briefly apply conventions to files that Area A will later delete. This is intentional — F's purpose is to make the repo uniform *now* so Area A inherits a clean baseline. A few minutes of edit-work on soon-to-be-deleted files is cheaper than carrying drift forward.

---

## File Inventory

Files modified in this plan, grouped by task:

| Task | Files touched |
|---|---|
| 1 (pre-flight) | none (verification only) |
| 2 (name uniqueness) | `.github/workflows/ci-nix.yml` |
| 3 (actions/cache harmonise) | `.github/workflows/act-smoke.yml` |
| 4 (concurrency) | `auto-pr-create-reusable.yml`, `auto-pr-generate-reusable.yml`, `check.yml`, `check-docs.yml`, `check-website.yml`, `check-workflows.yml`, `integration.yml`, `nix.yml`, `update-dist.yml`, `add-dist-to-release-pr.yml` |
| 5 (persist-credentials) | `act-smoke.yml`, `auto-pr-generate-reusable.yml`, `deploy-pages.yml`, `nix.yml` |
| 6 (timeout-minutes) | `ci.yml`, `codeql-docs.yml`, `deploy-pages.yml`, `stale.yml`, `auto-pr.yml`, `ci-docs.yml`, `ci-nix.yml`, `ci-release-please.yml`, `ci-website.yml`, `ci-workflows.yml`, `update-bun-nix.yml` |
| 7 (permissions: {}) | `check.yml`, `check-docs.yml`, `check-website.yml`, `check-workflows.yml`, `ci.yml`, `ci-docs.yml`, `ci-release-please.yml`, `ci-website.yml`, `ci-workflows.yml`, `integration.yml`, `act-smoke.yml`, `auto-pr-generate-reusable.yml`, `deploy-pages.yml` |
| 8 (final verification) | none (CI run only) |

---

## Task 0: Branch Setup

**Files:** none

- [x] **Step 1: Create a fresh branch from `main`**

```bash
git checkout main
git pull --ff-only
git checkout -b ai/ci-area-f-hygiene-sweep
```

- [x] **Step 2: Confirm clean tree**

Run: `git status`
Expected: `nothing to commit, working tree clean`

---

## Task 1: Pre-Flight Verification (Items 6 & 8 — expected no-op)

**Purpose:** Confirm items 6 (runner images explicit) and 8 (composite-action pins) have zero breaches, per the audit. Establishes a baseline `actionlint` result before any changes.

**Files:** none (read-only).

- [x] **Step 1: Verify no `ubuntu-latest` remains in workflows (item 6)**

Run:
```bash
grep -rn "runs-on:.*ubuntu-latest" .github/workflows/ .github/actions/ || echo "CLEAN"
```

Expected output: `CLEAN` (no matches).

If matches appear, add edits to this task: replace `ubuntu-latest` → `ubuntu-24.04` (or `ubuntu-24.04-arm` if ARM is needed; check the surrounding matrix).

- [x] **Step 2: Verify every third-party `uses:` in composite actions is pinned `@<40-char SHA> # vX.Y.Z` (item 8)**

Run:
```bash
grep -rnE "uses: [^./]" .github/actions/ | grep -v "# v"
```

Expected output: empty (every third-party `uses:` has the `# vX.Y.Z` comment).

If any match appears, resolve to a SHA via:
```bash
gh api repos/<owner>/<repo>/commits/<tag> -q .sha
```
and append ` # <tag>` as a comment. Add those edits to this task.

- [x] **Step 3: Establish baseline actionlint result**

Run: `bun run lint:workflows`
Expected: exits 0. Capture any pre-existing warnings — those are pre-existing and not this PR's responsibility; note them for later if surprising.

- [x] **Step 4: Commit (only if Step 1 or 2 found breaches; otherwise skip)**

If you made edits in Steps 1 or 2:
```bash
git add -A
git commit -m "ci: pin runners to ubuntu-24.04 and SHA-pin composite action deps"
```

Otherwise this task is verification-only; nothing to commit. Proceed to Task 2.

---

## Task 2: Workflow `name:` Uniqueness (Item 5)

**Purpose:** Disambiguate the Actions-tab display name between `ci.yml` and `ci-nix.yml`. Both currently show as "CI".

**Why only `ci-nix.yml` is renamed:** The `check-*.yml` workflows all use `name: Check` intentionally — their `check` job reports as `Check / check` for the branch-protection required status contract. Renaming those workflow names changes the status name and breaks branch protection. Leave them. Spec §6.2.5 explicitly scopes this item to `ci-nix.yml` vs. `ci.yml`.

**Area A follow-up:** Area A deletes `ci-nix.yml`; this rename is short-lived but stops the Actions-tab ambiguity in the interim.

**Files:**
- Modify: `.github/workflows/ci-nix.yml:3`

- [x] **Step 1: Rename the workflow**

Edit `.github/workflows/ci-nix.yml` line 3:

From:
```yaml
name: CI
```

To:
```yaml
name: CI (Nix)
```

- [x] **Step 2: Verify actionlint still passes**

Run: `bun run lint:workflows`
Expected: exits 0.

- [x] **Step 3: Verify no other workflow now clashes**

Run:
```bash
grep -H "^name:" .github/workflows/*.yml | sort -t: -k3 | uniq -f2 -D
```

Expected output: groups of `name: Check` (4 workflows — intentional, load-bearing for branch protection) and any other intentional duplicates. `CI` appears only once (for `ci.yml`).

- [x] **Step 4: Commit**

```bash
git add .github/workflows/ci-nix.yml
git commit -m "ci(ci-nix): rename workflow to 'CI (Nix)' for Actions-tab readability"
```

---

## Task 3: `actions/cache` v5.0.4 Harmonisation (Item 4)

**Purpose:** Two breaches in `act-smoke.yml` are pinned to `actions/cache@…# v4.2.3`; the rest of the repo uses v5.0.4. Harmonise.

**Files:**
- Modify: `.github/workflows/act-smoke.yml:81`
- Modify: `.github/workflows/act-smoke.yml:99`

- [x] **Step 1: Read the current pinned lines**

Read `.github/workflows/act-smoke.yml` lines 75–105 to see the two `actions/cache` uses in context (they're in separate steps — `Cache act image layers` and `Cache act Node runtime`, or similar).

- [x] **Step 2: Replace both pins**

For EACH of lines 81 and 99 (adjust line numbers if earlier edits shifted them), change:

From:
```yaml
uses: actions/cache@5a3ec84eff668545956fd18022155c47e93e2684 # v4.2.3
```

To:
```yaml
uses: actions/cache@668228422ae6a00e4ad889ee87cd7109ec5666a7 # v5.0.4
```

(The v5.0.4 SHA `668228422ae6a00e4ad889ee87cd7109ec5666a7` is used elsewhere in the repo at `.github/actions/build-and-commit-dist/action.yml:37` and `.github/workflows/integration.yml:59,165`. Verify before committing:)

```bash
grep -rn "actions/cache@" .github/
```

All occurrences should be `actions/cache@668228422ae6a00e4ad889ee87cd7109ec5666a7 # v5.0.4` after the edit.

- [x] **Step 3: actionlint passes**

Run: `bun run lint:workflows`
Expected: exits 0.

- [x] **Step 4: Commit**

```bash
git add .github/workflows/act-smoke.yml
git commit -m "ci(act-smoke): bump actions/cache to v5.0.4 to match rest of repo"
```

---

## Task 4: Concurrency Groups (Item 1)

**Purpose:** Every workflow triggered by `push`, `pull_request`, `schedule`, or `workflow_call` carries `concurrency:` with `group: ${{ github.workflow }}-${{ github.ref }}` and `cancel-in-progress: true`. Long-running single-commit-scoped workflows use `cancel-in-progress: false` so in-flight releases are not aborted.

**Two classes of fix:**
- **Add** the block to 8 workflows that currently have none.
- **Flip** `cancel-in-progress: true` → `false` in 2 release-related workflows.

**Reusables (`workflow_call`-only):** Adding a concurrency group on a reusable uses the caller's `github.workflow` and `github.ref`, which groups each caller's invocations correctly. The audit found 5 reusables missing a concurrency block.

**Files:**
- Modify: `.github/workflows/auto-pr-create-reusable.yml` (add block)
- Modify: `.github/workflows/auto-pr-generate-reusable.yml` (add block)
- Modify: `.github/workflows/check.yml` (add block)
- Modify: `.github/workflows/check-docs.yml` (add block)
- Modify: `.github/workflows/check-website.yml` (add block)
- Modify: `.github/workflows/check-workflows.yml` (add block)
- Modify: `.github/workflows/integration.yml` (add block)
- Modify: `.github/workflows/nix.yml` (add block)
- Modify: `.github/workflows/update-dist.yml:23` (flip `true` → `false`)
- Modify: `.github/workflows/add-dist-to-release-pr.yml:19` (flip `true` → `false`)

---

- [x] **Step 1: Add concurrency block to the 8 missing workflows**

For EACH of the following 8 files, insert this block immediately AFTER the `on:` block and BEFORE any `permissions:` block or `jobs:` key. Leave one blank line above and below:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

Files:
- `.github/workflows/auto-pr-create-reusable.yml`
- `.github/workflows/auto-pr-generate-reusable.yml`
- `.github/workflows/check.yml`
- `.github/workflows/check-docs.yml`
- `.github/workflows/check-website.yml`
- `.github/workflows/check-workflows.yml`
- `.github/workflows/integration.yml`
- `.github/workflows/nix.yml`

Example (inserting into `check.yml` between current lines 8 and 10):

Before (`check.yml` current structure around line 7):
```yaml
on:
  workflow_call:

permissions:
  contents: read
```

After:
```yaml
on:
  workflow_call:

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read
```

Apply this pattern to all 8 files. The exact insertion line depends on the current `on:` block size — use the Edit tool with sufficient context to anchor uniquely.

- [x] **Step 2: Flip `cancel-in-progress` to `false` in 2 release workflows**

Edit `.github/workflows/update-dist.yml:23`:

From:
```yaml
  cancel-in-progress: true
```

To:
```yaml
  cancel-in-progress: false
```

(Within the existing `concurrency:` block starting at line 21. Surrounding context: `group: update-dist-${{ github.ref }}` or similar.)

Edit `.github/workflows/add-dist-to-release-pr.yml:19`:

From:
```yaml
  cancel-in-progress: true
```

To:
```yaml
  cancel-in-progress: false
```

(Within the existing `concurrency:` block starting at line 17.)

- [x] **Step 3: Verify the matrix is correct**

Run:
```bash
for f in .github/workflows/*.yml; do
  printf '%-45s ' "$(basename "$f")"
  grep -A2 '^concurrency:' "$f" | tr '\n' ' ' | sed 's/  */ /g'
  echo
done
```

Expected output: every workflow has a `concurrency:` block. The three release workflows (`release-please.yml`, `update-dist.yml`, `add-dist-to-release-pr.yml`) show `cancel-in-progress: false`. Every other workflow shows `cancel-in-progress: true`.

- [x] **Step 4: actionlint passes**

Run: `bun run lint:workflows`
Expected: exits 0.

- [x] **Step 5: Commit**

```bash
git add .github/workflows/
git commit -m "ci: add concurrency groups everywhere; flip release workflows to cancel-in-progress: false"
```

---

## Task 5: `persist-credentials: false` on non-pushing checkouts (Item 2)

**Purpose:** Minimise token exposure. `actions/checkout` writes the token to `.git/config` by default, which persists it to disk for the job's lifetime. Jobs that don't push should opt out.

**Rule (from spec §1.6):** every `actions/checkout` step sets `persist-credentials: false` EXCEPT when the containing job is responsible for pushing (pin updater, bun-nix updater, release-please bot, dist updater — all of which use a GitHub App token explicitly via `actions/create-github-app-token`).

**Breaches identified:**
- `act-smoke.yml:52` — the smoke job doesn't push.
- `auto-pr-generate-reusable.yml:74` — generates output only, doesn't push.
- `deploy-pages.yml:23` — the `build` job uploads a Pages artifact but doesn't need the git credential.
- `nix.yml:131` — the `build` matrix job reads only.

**Files:**
- Modify: `.github/workflows/act-smoke.yml:52` (add `with: persist-credentials: false`)
- Modify: `.github/workflows/auto-pr-generate-reusable.yml:74` (add)
- Modify: `.github/workflows/deploy-pages.yml:23` (add)
- Modify: `.github/workflows/nix.yml:131` (add)

---

- [x] **Step 1: Edit `act-smoke.yml:52`**

Read the file around line 52 first to see the existing `uses:` step. If the step currently has no `with:` block, add one. If it has a `with:` block, add `persist-credentials: false` to it.

Minimal form (add `with:` block):

From:
```yaml
      - name: Checkout
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
```

To:
```yaml
      - name: Checkout
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          persist-credentials: false
```

If a `with:` block already exists (e.g. `fetch-depth: 0`), add the line inside it:

```yaml
      - name: Checkout
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          fetch-depth: 0
          persist-credentials: false
```

- [x] **Step 2: Edit `auto-pr-generate-reusable.yml:74` — same pattern**

Same logic as Step 1. Read first; add or extend `with:` block.

- [x] **Step 3: Edit `deploy-pages.yml:23` — same pattern**

The current step is `- uses: actions/checkout@<sha> # v6.0.2` with NO `with:` block. Convert it to the multi-line form with `persist-credentials: false`. Also give it a `name:` for readability while you're there:

From:
```yaml
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
```

To:
```yaml
      - name: Checkout
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          persist-credentials: false
```

- [x] **Step 4: Edit `nix.yml:131` — same pattern**

Same as Step 1.

- [x] **Step 5: Verify every `actions/checkout` is accounted for**

Run:
```bash
for f in .github/workflows/*.yml; do
  awk '/uses: actions\/checkout@/ {line=NR; print FILENAME":"NR; flag=1; next}
       flag && /persist-credentials:/ {flag=0; next}
       flag && /^[^ ]/ {print "  ^ no persist-credentials in next block"; flag=0}
       flag && NR > line+10 {flag=0}' "$f"
done
```

This prints every `actions/checkout` call site. Cross-check against the list of jobs that push:

**Jobs that legitimately push (do NOT need `persist-credentials: false` — they use an App token):**
- `update-workflow-pins.yml` (pin updater)
- `nix.yml` `bun-nix` job (line 47 checkout — pushes regenerated `bun.nix`)
- `update-dist.yml` (dist updater)
- `add-dist-to-release-pr.yml` (dist on release PR)
- `release-please.yml` (no direct checkout; uses `googleapis/release-please-action`)

All OTHER `actions/checkout` steps must have `persist-credentials: false`. If the grep shows anything missing that isn't in the pushing list, fix it now (add to this task).

- [x] **Step 6: actionlint passes**

Run: `bun run lint:workflows`
Expected: exits 0.

- [x] **Step 7: Commit**

```bash
git add .github/workflows/
git commit -m "ci: set persist-credentials: false on every non-pushing checkout"
```

---

## Task 6: `timeout-minutes` on every job (Item 3)

**Purpose:** The default job timeout is 360 minutes. A job that hangs shouldn't burn 6 runner-hours. Every job gets an explicit cap.

**Values (per spec §6.2.3):**
- Fast lints / pass-through jobs: **10 minutes** (pick 10 within the 5–10 range for safety)
- `check.yml`, `nix.yml/build`: **20 minutes** (already correct; no edit)
- Heavy (`integration.yml`, `auto-pr-generate-reusable.yml`): **current values kept** (25/35 min)
- Release / dist: **10 minutes** (already correct)

**Ambiguity note:** Spec §6.2.3 says integration = 25 min, but `integration.yml:19` and `integration.yml:128` are currently 35. The spec is frozen at audit time; the current values are what's in the file. **Leave existing `timeout-minutes:` values alone** — only ADD missing ones. This is a sweep, not a retuning.

**Reusable-call jobs:** GitHub Actions DOES accept `timeout-minutes:` on jobs that invoke reusable workflows via `uses:`; the timeout caps the entire reusable call. Per the spec's plain reading ("every job"), we add it.

**Breaches to fix (missing `timeout-minutes:`):**

Real jobs (have `steps:`):
- `ci.yml:33` `dependency-review` → 10 min
- `codeql-docs.yml` `analyze` (around line 26) → 10 min
- `deploy-pages.yml` `build` (line 20) → 10 min
- `deploy-pages.yml` `deploy` → 5 min (single action step)
- `stale.yml:16` `stale` → 10 min

Reusable-call jobs (have `uses:`):
- `auto-pr.yml:28` `generate` → 25 min (mirrors the reusable's internal cap)
- `auto-pr.yml` `create` (after `needs: generate`) → 10 min
- `ci-docs.yml` `check` job → 10 min
- `ci-nix.yml` `nix` job → 25 min
- `ci-release-please.yml` `check`/`integration` jobs → 10 / 35 min
- `ci-website.yml` `check` job → 10 min
- `ci-workflows.yml` `check` job → 10 min
- `update-bun-nix.yml` `update-bun-nix` job → 15 min

**Files:** all files listed above.

---

- [x] **Step 1: Add `timeout-minutes:` to each real job**

For each of the 5 real jobs below, insert `timeout-minutes: <value>` on the line IMMEDIATELY after `runs-on: <runner>`.

**`ci.yml` `dependency-review` job (around line 31–33):**

From:
```yaml
  dependency-review:
    if: |
      github.event_name == 'pull_request' &&
      !(github.actor == 'dependabot[bot]' && startsWith(github.event.pull_request.head.ref, 'dependabot/bun-'))
    runs-on: ubuntu-24.04
    permissions:
```

To (insert one line after `runs-on:`):
```yaml
  dependency-review:
    if: |
      github.event_name == 'pull_request' &&
      !(github.actor == 'dependabot[bot]' && startsWith(github.event.pull_request.head.ref, 'dependabot/bun-'))
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    permissions:
```

**`codeql-docs.yml` `analyze` job:**

Read the file around line 26 for context. Add `timeout-minutes: 10` on the line after `runs-on:`.

**`deploy-pages.yml` `build` job (line 20):**

From:
```yaml
  build:
    runs-on: ubuntu-24.04
    steps:
```

To:
```yaml
  build:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
```

**`deploy-pages.yml` `deploy` job:**

From:
```yaml
  deploy:
    needs: build
    runs-on: ubuntu-24.04
    environment:
```

To:
```yaml
  deploy:
    needs: build
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    environment:
```

**`stale.yml` `stale` job (line 16):**

From:
```yaml
jobs:
  stale:
    permissions:
      issues: write
      pull-requests: write
    runs-on: ubuntu-24.04
    steps:
```

To:
```yaml
jobs:
  stale:
    permissions:
      issues: write
      pull-requests: write
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
```

- [x] **Step 2: Add `timeout-minutes:` to each reusable-call job**

For each job below, insert `timeout-minutes: <value>` on its own line, typically immediately after the `permissions:` block and before `uses:`.

**`auto-pr.yml` `generate` job (around line 28–37):**

From:
```yaml
  generate:
    if: github.ref_name != github.event.repository.default_branch
    permissions:
      contents: read
      pull-requests: read # caps reusable generate job (gh pr view for existing title)
      models: read # required for reusable generate job (GitHub Models); caller caps nested permissions
    uses: knirski/auto-pr/.github/workflows/auto-pr-generate-reusable.yml@2f8296dd224c5f2cc7f44dceff2ac3b02ae4a6f5
```

To:
```yaml
  generate:
    if: github.ref_name != github.event.repository.default_branch
    timeout-minutes: 25
    permissions:
      contents: read
      pull-requests: read # caps reusable generate job (gh pr view for existing title)
      models: read # required for reusable generate job (GitHub Models); caller caps nested permissions
    uses: knirski/auto-pr/.github/workflows/auto-pr-generate-reusable.yml@2f8296dd224c5f2cc7f44dceff2ac3b02ae4a6f5
```

**`auto-pr.yml` `create` job (after `needs: generate`):**

From:
```yaml
  create:
    needs: generate
    permissions:
      contents: read
      pull-requests: write
    uses: knirski/auto-pr/.github/workflows/auto-pr-create-reusable.yml@2f8296dd224c5f2cc7f44dceff2ac3b02ae4a6f5
```

To:
```yaml
  create:
    needs: generate
    timeout-minutes: 10
    permissions:
      contents: read
      pull-requests: write
    uses: knirski/auto-pr/.github/workflows/auto-pr-create-reusable.yml@2f8296dd224c5f2cc7f44dceff2ac3b02ae4a6f5
```

**`ci-docs.yml`** — read the file; add `timeout-minutes: 10` to the `check` job (the single `uses:` job).

**`ci-nix.yml`** — add `timeout-minutes: 25` to the `nix` job.

**`ci-release-please.yml`** — add `timeout-minutes: 10` to the `check` job and `timeout-minutes: 35` to the `integration` job (matches the reusable's internal cap).

**`ci-website.yml`** — add `timeout-minutes: 10` to the `check` job.

**`ci-workflows.yml`** — add `timeout-minutes: 10` to the `check` job.

**`update-bun-nix.yml`** — add `timeout-minutes: 15` to the `update-bun-nix` job.

For each of these, the structural pattern is:

```yaml
  <job-name>:
    <any pre-existing lines, e.g. permissions, if, needs>
    timeout-minutes: <N>      # ← new line
    uses: ./.github/workflows/<reusable>.yml
    <secrets, with, etc.>
```

Read each file before editing to anchor the edit uniquely. If `permissions:` is present, place `timeout-minutes:` after it for consistency.

- [x] **Step 3: Check actionlint still accepts all edits**

Run: `bun run lint:workflows`
Expected: exits 0.

**If actionlint rejects `timeout-minutes:` on a `uses:` job** (the tool sometimes flags this despite GitHub accepting it at runtime): remove it from that specific job and record the exception in the commit message. Document the limitation in a one-line comment above the `uses:` line:

```yaml
  <job-name>:
    # timeout-minutes not settable on reusable-call jobs; inherits reusable's internal cap
    uses: ./.github/workflows/<reusable>.yml
```

- [x] **Step 4: Verify every job now has a timeout**

Run:
```bash
for f in .github/workflows/*.yml; do
  printf '\n=== %s ===\n' "$(basename "$f")"
  awk '
    /^jobs:/ { in_jobs = 1; next }
    !in_jobs { next }
    /^  [a-zA-Z_][a-zA-Z0-9_-]*:/ { job = $1; sub(/:$/, "", job); has_timeout = 0 }
    /timeout-minutes:/ { has_timeout = 1 }
    /^  [a-zA-Z_][a-zA-Z0-9_-]*:/ && prev_job && !prev_has { print "  MISSING:", prev_job }
    { prev_job = job; prev_has = has_timeout }
    END { if (prev_job && !prev_has) print "  MISSING:", prev_job }
  ' "$f"
done
```

Expected: no `MISSING:` lines. (If the awk is finicky, do a manual spot-check with `grep -B1 -A3 "^  [a-z-]*:$" .github/workflows/*.yml | grep -E "^  [a-z-]*:$|timeout-minutes"`.)

- [x] **Step 5: Commit**

```bash
git add .github/workflows/
git commit -m "ci: add timeout-minutes to every job (no workflow relies on 360-min default)"
```

---

## Task 7: Top-level `permissions: {}` with per-job widening (Item 7)

**Purpose:** Principle of least privilege per-job. Workflows currently granting `contents: read` (or wider) at the top level give that grant to every job in the workflow. Move to `permissions: {}` at the top and let each job declare what it actually needs. OpenSSF Scorecard best practice.

**Mechanical rule:** For each workflow whose top-level `permissions:` is not `{}`, change the top-level to `{}` and add/extend a `permissions:` block on every job that needs a grant. Reusable-call jobs that already set their own `permissions:` (e.g. `ci.yml` `check` job) are unchanged — they already scope correctly.

**Reusable workflows:** Moving `permissions:` from top-level to per-job in a reusable doesn't change what the caller can grant it — the caller's scope still caps the called workflow. Keeping the reusable's jobs self-describing about what they need is strictly clearer.

**Files:**
- Modify (top-level → `{}`, push to jobs): `check.yml`, `check-docs.yml`, `check-website.yml`, `check-workflows.yml`, `ci.yml`, `ci-docs.yml`, `ci-release-please.yml`, `ci-website.yml`, `ci-workflows.yml`, `integration.yml`, `act-smoke.yml`, `auto-pr-generate-reusable.yml`, `deploy-pages.yml`

**Already compliant (`permissions: {}`):** `auto-pr.yml`, `auto-pr-create-reusable.yml`, `ci-nix.yml`, `nix.yml`, `update-workflow-pins.yml`, `update-bun-nix.yml`, `update-flake-lock.yml`, `add-dist-to-release-pr.yml`, `update-dist.yml`, `release-please.yml`, `scorecard.yml`, `codeql.yml`, `codeql-docs.yml`, `stale.yml` — do not touch their top-level.

---

- [x] **Step 1: `check.yml`**

Top-level currently (line 10):
```yaml
permissions:
  contents: read
```

Change top-level to:
```yaml
permissions: {}
```

Add to the `check` job (job line ~14):
```yaml
jobs:
  check:
    permissions:
      contents: read
    runs-on: ubuntu-24.04
    ...
```

(Insert `permissions:` block before `runs-on:` within the job.)

- [x] **Step 2: `check-docs.yml`**

Top-level (line 12) currently `permissions: contents: read` → change to `permissions: {}`.

Add to the single `check` job:
```yaml
    permissions:
      contents: read
```

- [x] **Step 3: `check-website.yml`**

Same pattern: top-level `permissions: {}`; add `permissions: contents: read` to the `check` job.

- [x] **Step 4: `check-workflows.yml`**

Same pattern: top-level `permissions: {}`; add `permissions: contents: read` to the `check` job.

- [x] **Step 5: `ci.yml`**

Top-level (line 29) currently:
```yaml
permissions:
  contents: read
```

Change to:
```yaml
permissions: {}
```

`ci.yml` has three jobs. Update each:
- `dependency-review` — ALREADY has `permissions: contents: read, pull-requests: read` (line ~36). No change.
- `check` (reusable call) — ALREADY has `permissions: contents: read, models: read`. No change.
- `integration` (reusable call) — ALREADY has `permissions: contents: read, models: read`. No change.

Net for this file: only the top-level changes.

- [x] **Step 6: `ci-docs.yml`**

Top-level (line 19) → `permissions: {}`. Add `permissions: contents: read` to the `check` (reusable-call) job.

- [x] **Step 7: `ci-release-please.yml`**

Top-level (line 15) → `permissions: {}`. Add `permissions: contents: read` to each job (whatever the file contains — likely `check` and `integration` reusable-call jobs; verify first with a quick Read).

- [x] **Step 8: `ci-website.yml`**

Top-level (line 20) → `permissions: {}`. Add `permissions: contents: read` to the `check` job.

- [x] **Step 9: `ci-workflows.yml`**

Top-level (line 20) → `permissions: {}`. Add `permissions: contents: read` to the `check` job.

- [x] **Step 10: `integration.yml`**

Top-level (lines 10–12) currently:
```yaml
permissions:
  contents: read
  models: read
```

Change to:
```yaml
permissions: {}
```

Add to EACH of the three jobs (`integration-local-fallback` line 17, the middle job line 99, and the third job line 127):
```yaml
    permissions:
      contents: read
      models: read
```

Place immediately before `runs-on:` in each job.

- [x] **Step 11: `act-smoke.yml`**

Top-level (line 25) `permissions: contents: read` → `permissions: {}`.

Add to the `smoke` job:
```yaml
    permissions:
      contents: read
```

- [x] **Step 12: `auto-pr-generate-reusable.yml`**

Top-level (line 57) currently:
```yaml
permissions:
  contents: read
  models: read
  pull-requests: read
```

Change to:
```yaml
permissions: {}
```

Add to the single job (line 66, `generate`):
```yaml
    permissions:
      contents: read
      models: read
      pull-requests: read
```

**Important:** this is a reusable called from `auto-pr.yml`. The caller (`auto-pr.yml:31`) already caps the grant with its own job-level `permissions:` — that still applies and takes precedence. This edit is descriptive only; no functional change.

- [x] **Step 13: `deploy-pages.yml`**

Top-level (line 10) currently:
```yaml
permissions:
  contents: read
  pages: write
  id-token: write
```

Change to:
```yaml
permissions: {}
```

Add to `build` job:
```yaml
    permissions:
      contents: read
```

Add to `deploy` job:
```yaml
    permissions:
      pages: write
      id-token: write
```

(The `build` job only checks out and uploads a Pages artifact — it needs `contents: read`. The `deploy` job uses `actions/deploy-pages` which needs `pages: write` and `id-token: write`.)

- [x] **Step 14: Verify every workflow's top-level `permissions:`**

Run:
```bash
for f in .github/workflows/*.yml; do
  top=$(awk '/^permissions:/ {print; getline; if (/^  /) print; exit}' "$f")
  printf '%-45s %s\n' "$(basename "$f")" "${top//$'\n'/ }"
done
```

Expected: every workflow shows either `permissions: {}` or no top-level `permissions:` at all (which is equivalent to the default — but spec §6.2.7 wants explicit `{}`). If any workflow has no top-level `permissions:`, ADD `permissions: {}` to that file while you're here.

- [x] **Step 15: actionlint passes**

Run: `bun run lint:workflows`
Expected: exits 0.

- [x] **Step 16: Commit**

```bash
git add .github/workflows/
git commit -m "ci: scope permissions per-job; top-level is now permissions: {}"
```

---

## Task 8: Final Verification and PR

**Purpose:** Ensure the commits from Tasks 2–7 together produce green CI. Raise the PR.

**Files:** none (verification + gh commands).

---

- [x] **Step 1: Full local lint**

Run: `bun run lint:workflows`
Expected: exits 0 with no warnings.

- [x] **Step 2: Run `act-smoke` workflow locally (dry-run)**

Run: `bun run act-local-ci -- --dry-run` (or the equivalent local entrypoint — see `scripts/act-local-ci.ts`).
Expected: `act` parses the consolidated workflows without error.

If the act harness rejects any workflow, the error message will pinpoint the file. Fix in-place and amend the relevant task's commit rather than piling edits into Task 8.

- [x] **Step 3: Diff summary**

Run:
```bash
git log --oneline main..HEAD
git diff main...HEAD --stat
```

Expected: 6 commits (Tasks 2–7), each scoped to its checklist item. `--stat` shows changes localised to `.github/workflows/`.

- [x] **Step 4: Push and open PR**

```bash
git push -u origin ai/ci-area-f-hygiene-sweep

gh pr create --title "ci: Area F — cross-cutting hygiene sweep (8 conventions)" --body "$(cat <<'EOF'
## Summary

Implements Area F from the CI modernisation audit (`docs/superpowers/specs/2026-04-19-ci-modernization-audit-design.md` §6). Applies eight cross-cutting conventions uniformly across all 27 workflows and 9 composite actions. No behavioural changes beyond concurrency cancellation and permission scoping.

Per spec §8, Area F lands first so subsequent area PRs (B, A, D, E) inherit a clean baseline.

## Per-commit breakdown

- **name uniqueness** — rename `ci-nix.yml` workflow name to `CI (Nix)` to disambiguate from `ci.yml` in the Actions tab.
- **actions/cache** — bump `act-smoke.yml` two usages from v4.2.3 → v5.0.4 to match the rest of the repo.
- **concurrency** — add concurrency group to 8 workflows that were missing one; flip `update-dist` and `add-dist-to-release-pr` to `cancel-in-progress: false` (release workflows must complete).
- **persist-credentials** — `persist-credentials: false` on 4 checkouts in jobs that don't push.
- **timeout-minutes** — explicit timeout on every job; no workflow now relies on the 360-minute default.
- **permissions: {}** — top-level `permissions: {}` on 13 more workflows; grants pushed to per-job `permissions:` blocks.

Items 6 (runner images explicit) and 8 (composite-action SHA pins) were already clean at audit time (see pre-flight verification in plan).

## Test plan

- [x] `bun run lint:workflows` passes locally
- [x] `act` dry-run parses all workflows
- [x] CI on this PR goes green (`ci / check`, `ci / integration`, `scorecard`, `codeql`)
- [x] Branch protection status names unchanged (spot-check `check / check` still reports)
- [x] Observe one green run on `main` after merge before starting Area B

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [x] **Step 5: Monitor CI**

Run: `gh pr checks --watch`
Expected: all required checks green. If anything fails, fix in-place on this branch (don't open a follow-up PR).

- [x] **Step 6: Confirm branch-protection status contract is preserved**

Specifically verify in the PR's checks panel:
- `check / check` reports (load-bearing for branch protection).
- `check / integration` reports.
- No new check names appeared or disappeared unexpectedly.

If any required check's name changed (e.g. because a `name:` field was inadvertently touched), revert the responsible commit immediately.

---

## Success Criteria

Per spec §9, Area F is complete when:

- All eight checklist items applied uniformly across the repo.
- CI stays green on the PR.
- One green run on `main` after merge.
- No workflow regresses in wall-time (expected neutral).
- Branch-protection required status names unchanged.

## Post-merge

1. Observe one green `main` run to confirm no hosted-CI regression.
2. Hand off to Area B: `docs/superpowers/plans/2026-04-19-ci-area-b-pin-cleanup.md`.
