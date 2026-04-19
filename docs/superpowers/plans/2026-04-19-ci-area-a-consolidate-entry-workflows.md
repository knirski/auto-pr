# CI Area A — Consolidate Entry Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Important — this plan produces TWO pull requests separated by human-coordinated branch-protection changes.** Phase 1 (Tasks 0–6) adds a single consolidated `ci.yml` alongside the old entry workflows; Phase 2 (Tasks 9–13) deletes the old entry workflows. Between them, Tasks 7–8 are manual branch-protection steps the user performs in the GitHub UI. DO NOT proceed past Task 6 without confirming the manual steps are complete.

**Goal:** Replace six fan-out entry workflows (`ci.yml`, `ci-docs.yml`, `ci-website.yml`, `ci-workflows.yml`, `ci-release-please.yml`, `ci-nix.yml`) with one consolidated `ci.yml` driven by `dorny/paths-filter` and a `gate` job that satisfies branch protection. Reduces entry-file count from 6 to 1, eliminates the `check / check` pass-through lies for docs-only PRs, and collapses branch-protection required checks to a single `ci / gate`.

**Architecture:**
- One `ci.yml` with nine jobs: `changes` (paths-filter), `dependency-review`, `check`, `integration`, `docs-lint`, `website`, `workflows-lint`, `nix`, `gate`.
- Every work job is `needs: changes` and guarded by `if: needs.changes.outputs.<filter> == 'true'` (skipping when the filter doesn't match).
- `gate` is `needs: [all-others]`, `if: always()`, uses `jq` on `toJSON(needs)` to fail only if any needed job's `result` is not in `{success, skipped}`.
- Three thin domain reusables (`check-docs.yml`, `check-website.yml`, `check-workflows.yml`) are preserved and called from the consolidated `ci.yml`. The spec's §2.3 "Keep" list omits `check-docs.yml`; this plan overrides per principle 1.2 ("logic lives in reusables") — keeping it matches the symmetry of the other thin reusables.

**Tech Stack:** GitHub Actions YAML, `dorny/paths-filter@v3`, `jq` (pre-installed on ubuntu-24.04), `actionlint` via `bun run lint:workflows`, `gh` CLI for branch-protection configuration and SHA resolution.

**Reference spec:** `docs/superpowers/specs/2026-04-19-ci-modernization-audit-design.md` §2 (Area A).

**Branch (Phase 1):** `ai/ci-area-a-phase-1-consolidate-entry-workflows`
**Branch (Phase 2):** `ai/ci-area-a-phase-2-remove-legacy-entries`

**Dependency ordering:** Per spec §8, Area A lands third (after F and B). This plan assumes F and B have merged; line numbers may have shifted. Anchor edits on textual context.

**Out of scope:**
- Changing `integration.yml`'s internal structure or job count.
- Changing `check.yml`'s contents (done in Areas F / B already).
- Changing `nix.yml`'s fork-safe push-gating (the `push_allowed` input is preserved verbatim).
- CodeQL (`codeql.yml` / `codeql-docs.yml`) — separate fan-out, out of Area A's stated scope.
- `scorecard.yml`, `deploy-pages.yml`, `stale.yml`, `release-please.yml`, `update-*.yml` — unrelated workflows.

---

## Background: why this is a two-PR plan

GitHub branch-protection requires a specific status-check name (or set of names). You cannot simultaneously (a) remove old required checks and (b) delete the workflows that produce them, because:

- If you delete workflows first, in-flight PRs fail branch protection (`check / check` never reports; it's still required).
- If you add `ci / gate` as required while the old workflows still run, docs-only PRs have to show BOTH `check / check` (from legacy `ci-docs.yml`) AND `ci / gate` (from consolidated `ci.yml`) — which works, because both report green.

The safe sequence is:

1. **Phase 1 PR** merges consolidated `ci.yml` WHILE keeping legacy entry workflows. Every PR now triggers both systems; branch protection still requires `check / check` (+ `check / integration` etc.); `ci / gate` also reports.
2. **Human step:** user adds `ci / gate` to required checks (additive).
3. **Verify** one real PR: both systems green.
4. **Human step:** user REMOVES `check / check` and other legacy required checks from branch protection.
5. **Phase 2 PR** deletes the legacy entry workflows. Nothing relies on them anymore.

Reversing 4 and 5 breaks branch protection temporarily (step 5 first → docs-only PRs can't report `check / check`, blocking merges).

---

## File Inventory

| Phase | Task | Files |
|---|---|---|
| 1 | 1 — resolve dorny/paths-filter SHA | none (lookup only) |
| 1 | 2 — Dependabot entry | (no change; dorny/paths-filter already covered by `gh-actions-minor-patch` group) |
| 1 | 3 — rewrite `ci.yml` | `.github/workflows/ci.yml` (full rewrite) |
| 1 | 4 — update `docs/CI.md` | `docs/CI.md` (Branch Protection section) |
| 1 | 5 — local verification | none (runs `actionlint`, `act` dry-run) |
| 1 | 6 — Phase 1 PR | none (just `gh pr create`) |
| — | 7–8 — human branch-protection steps | none (GitHub UI / `gh api`) |
| 2 | 9 — Phase 2 branch setup | none |
| 2 | 10 — delete legacy entries | `.github/workflows/ci-docs.yml` (delete), `ci-website.yml` (delete), `ci-workflows.yml` (delete), `ci-release-please.yml` (delete), `ci-nix.yml` (delete) |
| 2 | 11 — update `docs/CI.md` remaining references | `docs/CI.md`, other docs that reference deleted files |
| 2 | 12 — verify Phase 2 | none |
| 2 | 13 — Phase 2 PR | none |

---

# Phase 1: Introduce consolidated `ci.yml`

## Task 0: Phase 1 Branch Setup

**Files:** none.

- [ ] **Step 1: Fresh branch from `main`**

```bash
git checkout main
git pull --ff-only
git checkout -b ai/ci-area-a-phase-1-consolidate-entry-workflows
```

- [ ] **Step 2: Confirm Areas F and B merged**

```bash
git log --oneline --grep='Area F' main -5
git log --oneline --grep='Area B' main -5
```

Both should show merged commits. If either is missing, stop and complete that area first — line-number anchors in this plan assume both have landed.

- [ ] **Step 3: Confirm clean tree**

Run: `git status`
Expected: `nothing to commit, working tree clean`

---

## Task 1: Resolve `dorny/paths-filter` SHA pin

**Purpose:** Principle 1.4 requires third-party actions be pinned as `@<40-char-SHA> # vX.Y.Z`. Before editing `ci.yml`, resolve the exact SHA for `dorny/paths-filter`'s current stable tag.

**Files:** none (lookup only).

- [ ] **Step 1: Pick the latest stable v3 release tag**

Run:
```bash
gh api repos/dorny/paths-filter/releases --jq '.[] | select(.prerelease == false) | {tag: .tag_name, published: .published_at}' | head -5
```

Expected: a list of recent releases; the most recent v3.x tag (e.g. `v3.0.2`) is the target.

- [ ] **Step 2: Resolve the tag to a commit SHA**

```bash
TAG=v3.0.2  # or whichever v3.x is latest
gh api repos/dorny/paths-filter/commits/$TAG -q .sha
```

Expected: a 40-character lowercase hex SHA. **Save the tag and SHA for Task 3** — you'll paste them both into `ci.yml`.

Example (for illustration only — always re-resolve):
```
v3.0.2 → de90cc6fb38fc0963ad72b210f1f284cd68cea36
```

- [ ] **Step 3: Sanity-check against the action's README**

Open https://github.com/dorny/paths-filter in a browser and confirm v3.x is the current stable major. If there's a v4.x marked stable, consult its migration notes; otherwise proceed with v3.x.

---

## Task 2: Dependabot coverage

**Purpose:** Ensure `dorny/paths-filter` is tracked by Dependabot so future patch bumps flow automatically.

**Files:** `.github/dependabot.yml` (likely no change needed).

- [ ] **Step 1: Verify the existing `github-actions` group covers all patterns**

Read `.github/dependabot.yml`. The `github-actions` entry should have:

```yaml
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
    groups:
      gh-actions-minor-patch:
        patterns: ["*"]
        update-types: ["minor", "patch"]
```

The `patterns: ["*"]` catches every action, so `dorny/paths-filter` is automatically grouped. **No edit required.**

- [ ] **Step 2: Confirm no action-specific exclusion**

```bash
grep -n "dorny" .github/dependabot.yml
```

Expected: no matches (no explicit handling needed).

No commit in this task.

---

## Task 3: Rewrite `ci.yml` in consolidated form

**Purpose:** Replace the current 3-job `ci.yml` (dependency-review, check, integration) with the 9-job consolidated form. This is the heart of Phase 1.

**Files:** `.github/workflows/ci.yml` (full rewrite).

**Key design decisions baked into the content below:**
- **No paths-ignore at the workflow level.** The consolidated `ci.yml` always fires on `push`/`pull_request`/`workflow_dispatch` to `main`. Path filtering happens inside via `dorny/paths-filter`. This removes the "release-please PR doesn't trigger `ci.yml`" quirk by making `ci.yml` unconditional.
- **The `code` filter** mirrors the current `paths-ignore` in `ci.yml` exactly: everything EXCEPT `**/*.md`, `.github/**`, `website/**`. Nix files and `.release-please-manifest.json` are covered by `code` (same as current behavior).
- **Separate `nix` and `release_manifest` filters** exist per spec §2.3. `nix` fires on nix/dep paths; `release_manifest` fires only on `.release-please-manifest.json`. `release_manifest` is near-redundant (paths it matches are also in `code`), but is preserved as spec'd for belt-and-braces routing.
- **Gate semantics:** `gate` is `needs: [dependency-review, check, integration, docs-lint, website, workflows-lint, nix]`, `if: always()`. It fails if any needed job's `result` is not `success` or `skipped`. Branch protection requires only `ci / gate`.
- **`nix` job inputs preserved:** `ref` and `push_allowed` are passed through from `ci-nix.yml`'s current logic. Fork-PR push-gating stays.
- **`dependency-review`** stays inline (a single `uses:` action; extracting into a reusable for 6 lines is overkill). Principle 1.2 tension acknowledged but deferred.
- **Status-check names preserved for legacy compat:** the caller-job names `check`, `integration`, `dependency-review` match current `ci.yml` exactly, so `check / check`, `integration / integration-local-fallback`, etc. continue to report identically during the Phase 1 overlap. No in-flight PR breaks.

---

- [ ] **Step 1: Read the current `ci.yml`**

Read `.github/workflows/ci.yml` in full. The current version (after Areas F and B) should be roughly 60 lines: top-level `permissions: {}` (post-F), `concurrency:` block, three jobs (dependency-review, check, integration). Note any comments you want to preserve (the "Skip for Dependabot Bun PRs" rationale is load-bearing).

- [ ] **Step 2: Overwrite `.github/workflows/ci.yml`**

Replace the full contents with the following. Substitute `<DORNY_SHA>` and `<DORNY_TAG>` with the values resolved in Task 1.

```yaml
# CI: one entry workflow, path-filtered fan-out to per-domain jobs, single gate for branch protection.
# Replaces six pre-Area-A entry workflows (ci.yml + ci-docs + ci-website + ci-workflows + ci-release-please + ci-nix).
# See docs/CI.md §Branch Protection and docs/superpowers/specs/2026-04-19-ci-modernization-audit-design.md §2.

name: CI

on:
  push:
    branches:
      - main
  pull_request:
    branches:
      - main
  workflow_dispatch:

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions: {}

jobs:
  # Determine which groups of files changed, so work jobs only run when relevant.
  # Filter definitions mirror the pre-Area-A entry workflows' paths / paths-ignore exactly.
  changes:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    permissions:
      contents: read
      pull-requests: read # dorny/paths-filter reads PR file list via REST
    outputs:
      code: ${{ steps.filter.outputs.code }}
      docs: ${{ steps.filter.outputs.docs }}
      website: ${{ steps.filter.outputs.website }}
      workflows: ${{ steps.filter.outputs.workflows }}
      nix: ${{ steps.filter.outputs.nix }}
      release_manifest: ${{ steps.filter.outputs.release_manifest }}
    steps:
      - name: Checkout
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          persist-credentials: false
      - name: Compute path filters
        id: filter
        uses: dorny/paths-filter@<DORNY_SHA> # <DORNY_TAG>
        with:
          filters: |
            code:
              - '**'
              - '!**/*.md'
              - '!.github/**'
              - '!website/**'
            docs:
              - '**/*.md'
            website:
              - 'website/**'
            workflows:
              - '.github/**'
            nix:
              - '**/*.nix'
              - 'package*.json'
              - 'bun.lock'
              - 'flake.lock'
            release_manifest:
              - '.release-please-manifest.json'

  # Dependency review (PRs only; skipped for Dependabot Bun PRs because GitHub's
  # dependency graph may not support bun.lock yet — bun audit in `check` covers those).
  dependency-review:
    needs: changes
    if: |
      github.event_name == 'pull_request' &&
      !(github.actor == 'dependabot[bot]' && startsWith(github.event.pull_request.head.ref, 'dependabot/bun-'))
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    permissions:
      contents: read
      pull-requests: read
    steps:
      - name: Checkout
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          persist-credentials: false
      - name: Dependency review
        uses: actions/dependency-review-action@2031cfc080254a8a887f58cffee85186f0e49e48 # v4

  # Full check pipeline: lint, typecheck, unit tests, secret scan, workflow pin verify.
  # Runs for code changes and for release-please PRs (preserves ci-release-please.yml behavior).
  check:
    needs: changes
    if: needs.changes.outputs.code == 'true' || needs.changes.outputs.release_manifest == 'true'
    permissions:
      contents: read
      models: read
    uses: ./.github/workflows/check.yml
    secrets: inherit

  # Real-HTTP integration scenarios against a local llama-server. Code changes only.
  integration:
    needs: changes
    if: needs.changes.outputs.code == 'true'
    permissions:
      contents: read
      models: read
    uses: ./.github/workflows/integration.yml

  # Markdown lint + link check + spell check. Docs-only path.
  docs-lint:
    needs: changes
    if: needs.changes.outputs.docs == 'true'
    permissions:
      contents: read
    uses: ./.github/workflows/check-docs.yml

  # Astro build. Website-only path. (Mixed PRs touching code+website run both `check` and `website`.)
  website:
    needs: changes
    if: needs.changes.outputs.website == 'true'
    permissions:
      contents: read
    uses: ./.github/workflows/check-website.yml

  # actionlint + shellcheck + shfmt + self-referential pin verify. .github-only path.
  workflows-lint:
    needs: changes
    if: needs.changes.outputs.workflows == 'true'
    permissions:
      contents: read
    uses: ./.github/workflows/check-workflows.yml

  # Nix flake build matrix + bun.nix regeneration.
  # ref / push_allowed preserve fork-safe behavior (no push from fork PRs, target right commit).
  nix:
    needs: changes
    if: needs.changes.outputs.nix == 'true'
    permissions:
      contents: write
    uses: ./.github/workflows/nix.yml
    with:
      ref: ${{ github.event_name == 'pull_request' && github.head_ref || github.ref }}
      push_allowed: ${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}
    secrets: inherit

  # Required status check for branch protection.
  # Fails only if any needed job's result is not success or skipped.
  # `if: always()` ensures the gate runs even when a needed job failed or was cancelled.
  gate:
    needs: [dependency-review, check, integration, docs-lint, website, workflows-lint, nix]
    if: always()
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    permissions: {}
    steps:
      - name: Verify required checks
        env:
          NEEDS_JSON: ${{ toJSON(needs) }}
        run: |
          set -euo pipefail
          # jq -e exits non-zero on false; we capture it to produce a readable error.
          if ! echo "$NEEDS_JSON" | jq -e 'to_entries | all(.value.result == "success" or .value.result == "skipped")' > /dev/null; then
            echo "::error::One or more required jobs failed or were cancelled"
            echo "$NEEDS_JSON" | jq 'to_entries | map({job: .key, result: .value.result})'
            exit 1
          fi
          echo "All needed jobs passed or were skipped."
          echo "$NEEDS_JSON" | jq 'to_entries | map({job: .key, result: .value.result})'
```

- [ ] **Step 3: Substitute the SHA and tag**

Open `.github/workflows/ci.yml` and replace `<DORNY_SHA>` with the SHA from Task 1 Step 2, and `<DORNY_TAG>` with the tag (e.g. `v3.0.2`). Example:

From:
```yaml
        uses: dorny/paths-filter@<DORNY_SHA> # <DORNY_TAG>
```

To (example — use your resolved values):
```yaml
        uses: dorny/paths-filter@de90cc6fb38fc0963ad72b210f1f284cd68cea36 # v3.0.2
```

Double-check: the SHA is exactly 40 hex chars, all lowercase. The tag is in a comment after `#`.

- [ ] **Step 4: Verify structural invariants with actionlint**

Run: `bun run lint:workflows`
Expected: exits 0. If actionlint complains about:
- `jobs.gate.needs: unknown job "<name>"` — typo in the `needs:` list.
- `expression syntax error` — check the `if:` condition quoting.
- Unknown input on `uses: ./.github/workflows/nix.yml` — `ref` and `push_allowed` should be accepted (they're defined in `nix.yml`'s `workflow_call.inputs`).

Fix issues in place before proceeding.

- [ ] **Step 5: Quick self-check on the filter semantics**

Run:
```bash
grep -A 2 'outputs:' .github/workflows/ci.yml | head -15
```

Expected output: shows `code`, `docs`, `website`, `workflows`, `nix`, `release_manifest` each mapped to `steps.filter.outputs.<same-name>`. Six outputs total.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: consolidate entry workflows into one path-filtered ci.yml with gate job"
```

---

## Task 4: Update `docs/CI.md` — document the new shape (without deleting legacy references yet)

**Purpose:** Update the Branch Protection section to name `ci / gate` as the new required check, while acknowledging the Phase 1 transitional state (old entries still in place, old required checks not yet removed).

**Why now, not in Phase 2:** The PR description references these docs; reviewers should see "here's what branch protection will require after this migration" at Phase 1 review time.

**Files:** `docs/CI.md` (Branch Protection section, lines ~133–143 pre-Area-A — may have shifted after F).

---

- [ ] **Step 1: Read the current Branch Protection section**

Read `docs/CI.md`; locate the `## Branch Protection` heading. Current content (abbreviated):

```markdown
## Branch Protection

Configure main branch protection to require:

- **`check / check`** — from [ci.yml](../.github/workflows/ci.yml), [ci-release-please.yml](...), [ci-docs.yml](...) (pass-through), [ci-website.yml](...) (pass-through), and [ci-workflows.yml](...) (via [check-workflows.yml](...)).
- **`check / integration`** — from [ci.yml](...) and [ci-release-please.yml](...). Not reported by ci-docs, ci-website, or ci-workflows (docs/website/workflow-only paths do not run integration).

Do not require `dependency-review` (PR-only), `nix` (path-filtered), or `act-smoke` (path-filtered smoke test); they would block when skipped or unrelated paths change.
```

- [ ] **Step 2: Replace the section**

Replace the Branch Protection section contents with:

```markdown
## Branch Protection

Configure main branch protection to require **a single status check**:

- **`CI / gate`** — reported by [ci.yml](../.github/workflows/ci.yml)'s `gate` job. The gate is `needs: [dependency-review, check, integration, docs-lint, website, workflows-lint, nix]` with `if: always()`, and fails only if any needed job's `result` is not `success` or `skipped`. A docs-only PR's `check` / `integration` / `website` / `workflows-lint` / `nix` jobs skip; `docs-lint` runs; `gate` evaluates success-or-skipped across all seven → passes. Same idea for every other path category.

Do NOT require individual job names (`check / check`, `dependency-review`, etc.) directly — they path-filter correctly inside `ci.yml` and are reported as skipped for unrelated changes, which would otherwise block branch protection.

### Migration state

During the Area A rollout (2026-04-19 onward), legacy entry workflows (`ci-docs.yml`, `ci-website.yml`, `ci-workflows.yml`, `ci-release-please.yml`, `ci-nix.yml`) run in parallel with the consolidated `ci.yml`. Both systems report green statuses. When the Phase 2 PR merges, the legacy entries are deleted; `CI / gate` becomes the sole required check.
```

Also **leave the `## Troubleshooting: "check / check" waiting for status` subsection in place for now** — it still applies during Phase 1 because `ci-nix.yml`'s bun.nix push still happens. Phase 2 will update it.

- [ ] **Step 3: Spot-check**

Run: `grep -n "check / check\|CI / gate\|ci / gate" docs/CI.md`

Expected: `CI / gate` appears in the replaced section. `check / check` may still appear in the Troubleshooting section (left in place intentionally) and in the "Self-referential pins" paragraph ("validation in every `check` and `check-workflows` run"), which is unrelated. Count of `check / check` occurrences should drop from ~5 to ~2.

- [ ] **Step 4: Commit**

```bash
git add docs/CI.md
git commit -m "docs(ci): document new CI / gate required check; note Area A migration state"
```

---

## Task 5: Local verification

**Files:** none (tests + smoke checks).

- [ ] **Step 1: actionlint full sweep**

Run: `bun run lint:workflows`
Expected: exits 0. Zero warnings on the rewritten `ci.yml`.

- [ ] **Step 2: `act` dry-run of consolidated ci.yml**

Run:
```bash
bun run act-local-ci -- --workflow ci --dry-run
```

(Or the project-specific entry point — see `scripts/act-local-ci.ts`.)

Expected: `act` parses the workflow without error, lists the 9 jobs, and prints the dependency graph without complaints.

If `act` errors with "unknown action dorny/paths-filter", the SHA may not be fetchable locally — that's fine, `act` typically fetches on demand. If it errors on syntax, fix in `ci.yml` and amend the Task 3 commit.

- [ ] **Step 3: Verify the gate-job semantics with a synthetic jq test**

Sanity-check the `jq` expression that will run inside the gate job:

```bash
# Simulate all success
echo '{"check":{"result":"success"},"integration":{"result":"success"},"docs-lint":{"result":"skipped"}}' \
  | jq -e 'to_entries | all(.value.result == "success" or .value.result == "skipped")' \
  && echo "PASS (expected)"

# Simulate one failure
echo '{"check":{"result":"success"},"integration":{"result":"failure"},"docs-lint":{"result":"skipped"}}' \
  | jq -e 'to_entries | all(.value.result == "success" or .value.result == "skipped")' \
  && echo "UNEXPECTED PASS" || echo "FAIL (expected)"

# Simulate one cancelled
echo '{"check":{"result":"cancelled"}}' \
  | jq -e 'to_entries | all(.value.result == "success" or .value.result == "skipped")' \
  && echo "UNEXPECTED PASS" || echo "FAIL (expected)"
```

Expected output:
```
PASS (expected)
FAIL (expected)
FAIL (expected)
```

(A `cancelled` job should cause the gate to fail, so `PR merges cleanly` depends on no jobs being cancelled.)

- [ ] **Step 4: Enumerate the overlap surface**

List every workflow that will fire on a PR after Phase 1 merges:

```bash
for f in .github/workflows/ci*.yml; do
  echo "=== $f ==="
  grep -A 8 '^on:' "$f" | head -12
done
```

Expected: six `ci*.yml` files each with `on: push / pull_request` triggers scoped to particular paths (except the new `ci.yml` which triggers unconditionally on main). During Phase 1 both systems run; this is intentional.

No commit in this task.

---

## Task 6: Phase 1 PR

**Files:** none (push and gh).

- [ ] **Step 1: Diff review**

Run:
```bash
git log --oneline main..HEAD
git diff main...HEAD --stat
```

Expected: 2 commits (Tasks 3 and 4). Stat shows `.github/workflows/ci.yml` fully rewritten (large diff) and `docs/CI.md` with a focused change to the Branch Protection section.

- [ ] **Step 2: Push and open PR**

```bash
git push -u origin ai/ci-area-a-phase-1-consolidate-entry-workflows

gh pr create --title "ci: Area A Phase 1 — consolidate entry workflows (additive, pre-migration)" --body "$(cat <<'EOF'
## Summary

Implements Phase 1 of Area A from the CI modernisation audit (`docs/superpowers/specs/2026-04-19-ci-modernization-audit-design.md` §2).

Rewrites `ci.yml` as a single consolidated workflow using `dorny/paths-filter` and a `gate` job. **Legacy entry workflows (`ci-docs.yml`, `ci-website.yml`, `ci-workflows.yml`, `ci-release-please.yml`, `ci-nix.yml`) remain in place.** Both systems run in parallel during the branch-protection migration. Phase 2 deletes the legacy entries after branch protection is pointed at `CI / gate`.

## What's new in `ci.yml`

1. `changes` job: `dorny/paths-filter` exposes `code`, `docs`, `website`, `workflows`, `nix`, `release_manifest` outputs.
2. `dependency-review` (PR-only, inline, preserved from current `ci.yml`).
3. `check` (calls `check.yml`; fires on `code` OR `release_manifest` — preserves `ci-release-please.yml` behavior).
4. `integration` (calls `integration.yml`; fires on `code`).
5. `docs-lint` (calls `check-docs.yml`; fires on `docs`).
6. `website` (calls `check-website.yml`; fires on `website`).
7. `workflows-lint` (calls `check-workflows.yml`; fires on `workflows`).
8. `nix` (calls `nix.yml` with `ref` + `push_allowed` preserved from `ci-nix.yml`).
9. `gate` (`needs` all of the above, `if: always()`, fails if any `result` ≠ success/skipped).

Branch protection will migrate from `check / check` + `check / integration` to a single `CI / gate` check. Migration sequence documented in spec §2.4 and plan Tasks 7–8.

## Branch-protection migration (human steps — do NOT merge this PR and the Phase 2 PR until these are done)

1. Merge this PR.
2. Wait for one green push on main (the consolidated `ci.yml` must have run at least once so GitHub knows the `CI / gate` check exists).
3. Branch-protection settings → add `CI / gate` as a required check (keep existing required checks).
4. Verify: open a small no-op PR; both legacy statuses and `CI / gate` report green.
5. Branch-protection settings → remove legacy required checks (`check / check`, `check / integration`).
6. Open Phase 2 PR (separate plan step) to delete legacy entry workflows.

## Test plan

- [ ] `bun run lint:workflows` passes
- [ ] `act` dry-run of `ci.yml` parses without error
- [ ] CI on this PR goes green (both legacy system AND new `ci / gate`)
- [ ] Spot-check the Actions tab — `CI` runs show all 9 jobs, with skipped jobs appearing greyed out per path category
- [ ] Confirm one docs-only PR (e.g. add a paragraph to `docs/README.md` in a follow-up test PR) triggers: `CI / gate` green, `check / check` green from `ci-docs.yml`, everything else skipped
- [ ] Confirm one code PR triggers: `CI / gate` green, plus `check / check`, `integration / *` etc. from legacy `ci.yml`... wait, this PR rewrote `ci.yml`, so only the NEW `ci.yml` runs. Expect: `CI / gate` green from new ci.yml, plus `check / check` green from legacy `ci-workflows.yml`/`ci-docs.yml` on paths those match, plus any other legacy entry matching the PR paths
- [ ] No PR fails branch protection due to a status going missing

## Risk

- **Status-check name collision:** Both the new `ci.yml` (workflow `name: CI`) and the legacy `ci-docs.yml` / `ci-website.yml` / `ci-workflows.yml` / `ci-release-please.yml` / `ci-nix.yml` also use `name: CI`. In the Actions tab this means multiple workflow runs appear under "CI" per PR, which is cosmetically noisy but functionally correct. Phase 2 restores one-`CI`-per-PR by deleting the legacy files.
- **Gate false-pass on `cancelled` or `timed_out`:** The jq check lists `success` and `skipped` as acceptable. `cancelled` and `timed_out` cause gate to FAIL — which is the right behavior (GitHub reruns should pass cleanly).
- **`release_manifest` filter is functionally redundant** with `code` (since `.release-please-manifest.json` matches `code` already). Kept per spec §2.3 so the filter vocabulary is explicit.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Watch CI**

Run: `gh pr checks --watch`
Expected: all statuses green. Both legacy and new systems report.

If `CI / gate` status fails:
- Click through to the gate job log; it prints the full `needs.*.result` table on failure.
- The most common cause at introduction time is one of the downstream reusables (`check.yml`, `integration.yml`, etc.) having a latent bug surfaced by the rerun. Fix separately; don't paper over by relaxing the gate's jq expression.

If `CI / gate` doesn't appear at all:
- Actions tab → CI run → verify the `gate` job is listed. If not, `ci.yml` has a structural error (e.g., `needs:` reference to a non-existent job).

- [ ] **Step 4: Confirm reviewers and merge**

Do not skip code review for this PR; the `gate` semantics are subtle. Once approved and all checks green, merge normally (squash or merge commit per team convention).

---

# Between Phases: Human-coordinated branch-protection migration

**DO NOT proceed to Task 9 until Tasks 7 and 8 are complete.** These are manual steps performed by a repository admin in the GitHub UI (or via `gh api`). No code changes.

## Task 7: Add `CI / gate` as a required check

**Purpose:** After Phase 1 merges and one green main run has registered the `CI / gate` check, add it to branch protection alongside (not replacing) the legacy required checks.

**Prerequisites:** Phase 1 PR merged to main; one push to main has completed with a green `CI / gate` status.

- [ ] **Step 1: Verify `CI / gate` exists in GitHub's check picker**

Option A (UI): Repository → Settings → Branches → `main` → Edit branch protection rule → "Require status checks to pass before merging" → search for `CI / gate`. It should autocomplete.

Option B (CLI):
```bash
gh api repos/knirski/auto-pr/branches/main/protection/required_status_checks \
  | jq '.contexts'
```

Expected output: a list including `check / check`, `check / integration`, and any others currently required. `CI / gate` is NOT yet in the list (that's Step 2).

- [ ] **Step 2: Add `CI / gate` to required checks**

Option A (UI): Add `CI / gate` to the list of required status checks; save.

Option B (CLI):
```bash
# Fetch current contexts and append ci / gate
CURRENT_CONTEXTS=$(gh api repos/knirski/auto-pr/branches/main/protection/required_status_checks --jq '.contexts')
NEW_CONTEXTS=$(echo "$CURRENT_CONTEXTS" | jq '. + ["CI / gate"]')
gh api -X PATCH repos/knirski/auto-pr/branches/main/protection/required_status_checks \
  -f strict=true \
  -f 'contexts[]=check / check' \
  -f 'contexts[]=check / integration' \
  -f 'contexts[]=CI / gate'  # + any others in CURRENT_CONTEXTS
```

(The exact `gh api` form depends on existing settings; UI is usually simpler and less error-prone. **Recommend UI.**)

- [ ] **Step 3: Verify the list**

```bash
gh api repos/knirski/auto-pr/branches/main/protection/required_status_checks --jq '.contexts'
```

Expected: list now contains `CI / gate` AND all previously-required checks.

- [ ] **Step 4: Smoke-test with a no-op PR**

Open a small throwaway PR (e.g. a whitespace change in a README). Observe in the PR's Checks panel:

- Legacy required statuses: green (from ci-docs.yml if the PR touches docs only, or from ci.yml's rewritten `check` / `integration` jobs if it touches code — or both).
- `CI / gate`: green.

Merge the throwaway PR. Delete the branch.

---

## Task 8: Remove legacy required checks

**Prerequisites:** Task 7 complete; at least one real PR has merged while `CI / gate` is required AND legacy checks are also required (both green).

- [ ] **Step 1: Remove legacy checks from branch protection**

Option A (UI, recommended): Settings → Branches → `main` → Edit → remove `check / check` and `check / integration` from the required list. Keep `CI / gate`.

Option B (CLI):
```bash
gh api -X PATCH repos/knirski/auto-pr/branches/main/protection/required_status_checks \
  -f strict=true \
  -F 'contexts=["CI / gate"]'
```

(Adjust the JSON shape per actual API requirements; the UI is simpler.)

- [ ] **Step 2: Verify only `CI / gate` remains required**

```bash
gh api repos/knirski/auto-pr/branches/main/protection/required_status_checks --jq '.contexts'
```

Expected output: exactly `["CI / gate"]` (plus any genuinely-independent checks you legitimately require, e.g. scorecard if it was previously required — don't remove those).

- [ ] **Step 3: Smoke-test docs-only PR**

Open a throwaway PR touching only `*.md`. Verify:
- `check / check` (from legacy `ci-docs.yml`) still reports green (it's still running, just no longer required).
- `CI / gate` reports green.
- PR is mergeable.

Merge the throwaway PR.

Once this passes, **Task 8 is complete and Phase 2 can proceed.**

---

# Phase 2: Delete legacy entry workflows

## Task 9: Phase 2 Branch Setup

- [ ] **Step 1: Fresh branch from latest `main`**

```bash
git checkout main
git pull --ff-only
git checkout -b ai/ci-area-a-phase-2-remove-legacy-entries
```

- [ ] **Step 2: Confirm Phase 1 has merged and Tasks 7–8 are complete**

```bash
git log --oneline --grep='Area A Phase 1' main -3
gh api repos/knirski/auto-pr/branches/main/protection/required_status_checks --jq '.contexts'
```

Expected:
- Phase 1 commit(s) present on main.
- Required checks list is `["CI / gate"]` (no legacy entries). If legacy entries remain, STOP — complete Task 8 first.

---

## Task 10: Delete legacy entry workflows

**Files (all deletions):**
- `.github/workflows/ci-docs.yml`
- `.github/workflows/ci-website.yml`
- `.github/workflows/ci-workflows.yml`
- `.github/workflows/ci-release-please.yml`
- `.github/workflows/ci-nix.yml`

---

- [ ] **Step 1: Delete the five entry workflows**

```bash
git rm .github/workflows/ci-docs.yml
git rm .github/workflows/ci-website.yml
git rm .github/workflows/ci-workflows.yml
git rm .github/workflows/ci-release-please.yml
git rm .github/workflows/ci-nix.yml
```

- [ ] **Step 2: Verify the retained reusables are still called by consolidated `ci.yml`**

```bash
grep -E "uses: \./\.github/workflows/(check-docs|check-website|check-workflows|nix)\.yml" .github/workflows/ci.yml
```

Expected output: four lines, one per retained reusable. If any is missing, the consolidated `ci.yml` is broken — investigate before continuing.

- [ ] **Step 3: Verify `check.yml` and `integration.yml` are still called**

```bash
grep -E "uses: \./\.github/workflows/(check|integration)\.yml" .github/workflows/ci.yml
```

Expected output: two lines (one for `check.yml`, one for `integration.yml`).

- [ ] **Step 4: Run actionlint on everything to catch dangling references**

Run: `bun run lint:workflows`
Expected: exits 0. No workflow references any of the deleted files.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "ci: remove legacy entry workflows (ci-docs, ci-website, ci-workflows, ci-release-please, ci-nix)"
```

---

## Task 11: Update `docs/CI.md` and other docs to remove legacy references

**Purpose:** The docs referenced the five deleted entry workflows in several places. Those references now point to nonexistent files — fix them.

**Files:**
- `docs/CI.md`

Other docs may reference the deleted entry workflows too. Sweep with grep.

---

- [ ] **Step 1: Find all references to deleted files**

```bash
grep -rn "ci-docs\.yml\|ci-website\.yml\|ci-workflows\.yml\|ci-release-please\.yml\|ci-nix\.yml" docs/ README.md CONTRIBUTING.md 2>/dev/null
```

Expected: a list of lines in `docs/CI.md` (and possibly `CONTRIBUTING.md`, `README.md`). Update each to either:
- Point to `ci.yml`'s corresponding job (e.g., "`ci-docs.yml`" → "the `docs-lint` job in `ci.yml`").
- Remove the reference if it was incidental (e.g., the Troubleshooting section that mentions "when ci-nix pushes a bun.nix update" — replace with "when the `nix` job in `ci.yml` pushes").

- [ ] **Step 2: Update `docs/CI.md` Branch Protection section**

Remove the "Migration state" subsection added in Task 4 Step 2 (it described the transitional state, which is now history).

Updated Branch Protection section should read (approximately):

```markdown
## Branch Protection

Configure main branch protection to require **a single status check**:

- **`CI / gate`** — reported by [ci.yml](../.github/workflows/ci.yml)'s `gate` job. The gate is `needs: [dependency-review, check, integration, docs-lint, website, workflows-lint, nix]` with `if: always()`, and fails only if any needed job's `result` is not `success` or `skipped`.

Do NOT require individual job names (`check / check`, `dependency-review`, etc.) directly — they path-filter correctly inside `ci.yml` and are reported as skipped for unrelated changes, which would otherwise block branch protection.
```

- [ ] **Step 3: Update the Troubleshooting subsection**

The existing `## Troubleshooting: "check / check" waiting for status` subsection references `ci-nix` pushing a `bun.nix` update. The `nix` job in consolidated `ci.yml` does the same thing; the symptom and fix are identical but the naming is different.

Rewrite to:

```markdown
## Troubleshooting: "CI / gate" waiting for status

When the `nix` job inside `ci.yml` pushes a bun.nix update, the PR head changes to a new commit. The required check must run on that new commit. If you see "waiting for status to be reported":

1. **Wait 1–2 minutes** — the push triggers the `ci.yml` workflow; it may take a moment to start.
2. **Re-run workflows** — if the check still hasn't run, use "Re-run all jobs" from the Actions tab.
3. **Manual trigger** — push an empty commit: `git commit --allow-empty -m "ci: trigger workflows" && git push`.
```

- [ ] **Step 4: Sweep other references**

Check:
```bash
grep -rn "ci-docs\.yml\|ci-website\.yml\|ci-workflows\.yml\|ci-release-please\.yml\|ci-nix\.yml" .
```

Update every match to reference `ci.yml` or its corresponding job. Likely candidates beyond `docs/CI.md`:
- `CONTRIBUTING.md`
- `README.md`
- `docs/adr/*.md` (ADRs — usually leave history intact; if an ADR *describes* the old fan-out, it's a historical record and should NOT be updated. Only update if it's a currently-applicable instruction.)
- `docs/TROUBLESHOOTING.md` if present
- `.github/PULL_REQUEST_TEMPLATE.md` if present
- Any comment in a composite action or other workflow referencing the deleted files

For each non-ADR match: update the reference. For ADR matches: leave as-is (history).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: remove references to deleted legacy entry workflows; update troubleshooting section"
```

---

## Task 12: Verify Phase 2

**Files:** none.

- [ ] **Step 1: Final actionlint**

Run: `bun run lint:workflows`
Expected: exits 0.

- [ ] **Step 2: Verify `ci.yml` is the only `ci*.yml` remaining**

```bash
ls .github/workflows/ci*.yml
```

Expected output: exactly `.github/workflows/ci.yml`.

- [ ] **Step 3: Verify no broken doc links**

```bash
grep -rn "ci-\(docs\|website\|workflows\|release-please\|nix\)\.yml" --include='*.md' --include='*.yml' .
```

Expected: no matches (or only in ADRs describing history — those are fine).

- [ ] **Step 4: Dry-run `act` on the final `ci.yml`**

```bash
bun run act-local-ci -- --workflow ci --dry-run
```

Expected: parses and graphs without error.

---

## Task 13: Phase 2 PR

- [ ] **Step 1: Diff summary**

```bash
git log --oneline main..HEAD
git diff main...HEAD --stat
```

Expected: 2 commits (Tasks 10 and 11). `--stat` shows 5 deletions under `.github/workflows/` and modifications to `docs/CI.md` plus any other doc files touched.

- [ ] **Step 2: Push and open PR**

```bash
git push -u origin ai/ci-area-a-phase-2-remove-legacy-entries

gh pr create --title "ci: Area A Phase 2 — remove legacy entry workflows (migration complete)" --body "$(cat <<'EOF'
## Summary

Finalises Area A from the CI modernisation audit (`docs/superpowers/specs/2026-04-19-ci-modernization-audit-design.md` §2). Deletes the five legacy entry workflows superseded by the consolidated `ci.yml` merged in Phase 1:

- `ci-docs.yml`
- `ci-website.yml`
- `ci-workflows.yml`
- `ci-release-please.yml`
- `ci-nix.yml`

All functionality migrated to jobs inside `ci.yml`:

| Legacy | New location |
|---|---|
| `ci-docs.yml` → `check-docs.yml` | `ci.yml` `docs-lint` job (still calls `check-docs.yml`) |
| `ci-website.yml` → `check-website.yml` | `ci.yml` `website` job (still calls `check-website.yml`) |
| `ci-workflows.yml` → `check-workflows.yml` | `ci.yml` `workflows-lint` job (still calls `check-workflows.yml`) |
| `ci-release-please.yml` → `check.yml` | `ci.yml` `check` job (fires on `release_manifest` OR `code`) |
| `ci-nix.yml` → `nix.yml` | `ci.yml` `nix` job (fires on `nix` filter; preserves `ref` + `push_allowed`) |

Branch protection now requires only `CI / gate`. Old required checks (`check / check`, `check / integration`) were removed from branch protection before this PR was opened (see plan Task 8).

## Test plan

- [ ] `bun run lint:workflows` passes
- [ ] CI on this PR goes green (`CI / gate` only)
- [ ] A docs-only follow-up PR: `docs-lint` runs, everything else skips, `CI / gate` green
- [ ] A website-only follow-up PR: `website` runs, everything else skips, `CI / gate` green
- [ ] A `.github/**`-only follow-up PR: `workflows-lint` runs, everything else skips, `CI / gate` green
- [ ] A nix-dep-touching follow-up PR: `nix` runs (plus `check` and `integration` since bun.lock is in `code` too)
- [ ] The next release-please PR still runs `check` (via `code` filter catching `.release-please-manifest.json`, or `release_manifest` filter as a belt-and-braces backup)

## Risk

- **In-flight PRs:** any PR open at the moment this merges sees their required-check list change under them. GitHub usually handles this gracefully — old checks are no longer required, new `CI / gate` was added pre-merge. Nevertheless: **rebase all open PRs after this lands** so they pick up the cleaner Actions run.
- **Out-of-repo callers:** none known. The legacy entry workflows are not reusables (no `workflow_call` trigger) so external invocations aren't possible. Safe to delete.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Watch CI**

Run: `gh pr checks --watch`
Expected: only `CI / gate` listed (plus any other independent checks like `Scorecard`). All green.

- [ ] **Step 4: Merge and announce**

Once approved and green, merge. Post a short note to the team channel (or pin an issue) noting the new `CI / gate` required check and linking to the updated `docs/CI.md §Branch Protection`.

---

## Success Criteria

Per spec §9 Area A:

- Branch protection requires `CI / gate` only.
- Five legacy entry workflows deleted.
- `dorny/paths-filter` pinned in `ci.yml`, covered by existing `gh-actions-minor-patch` Dependabot group.
- No hosted CI regressions for one week after Phase 2 merge.

Beyond the spec:

- `docs/CI.md` Branch Protection section matches reality.
- No dangling references to deleted entry workflows in docs (ADRs excluded — history is preserved).

## Post-merge Observation (1 week)

Watch for:
- PRs stuck in "waiting for status" because `CI / gate` didn't report. Likely cause: path filter misroutes. Investigate logs.
- Unexpected job runs (e.g., `integration` running on a docs-only PR). Likely cause: path filter over-matches (e.g., the `code` filter's exclusions didn't catch something). Tighten filters in a follow-up PR.
- `gate` false-fails on cancelled runs. Cancellations are usually manual (re-pushed the branch) — not a `gate` bug, but if they accumulate, consider adding `cancelled` to the acceptable-results set.

## Rollback plan

If Phase 2 causes breakage:
1. `git revert <phase-2-merge-sha>` on main (one commit reverts all five deletions).
2. Re-add legacy required checks to branch protection.
3. Investigate root cause before re-attempting.

The legacy workflows are simple restoration candidates; the `ci.yml` rewrite from Phase 1 is independently working, so reverting Phase 2 alone restores parallel coverage without losing the consolidated workflow.

## Hand-off

After Phase 2 merges cleanly and is stable for a week, the final two areas can proceed:
- **Area D (Nix cleanup):** `docs/superpowers/plans/<date>-ci-area-d-nix-cleanup.md` (not yet written)
- **Area E (act harness):** `docs/superpowers/plans/<date>-ci-area-e-act-harness-cleanup.md` (not yet written)

Neither depends on Area A; they're independently mergeable per spec §8.
