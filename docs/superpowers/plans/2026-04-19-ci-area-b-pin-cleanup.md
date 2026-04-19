# CI Area B — Self-Referential Pin Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the self-referential-pin surface area to the minimum viable set (three load-bearing files), harden the pin-update workflow's loop prevention against false positives, and record which files are load-bearing (and why) in `docs/CI.md`.

**Architecture:** Three small edits landing in one PR:
1. One YAML edit in `check.yml` converts a convertible self-ref to `./` and deletes a stale comment.
2. One `if:` expression in `update-workflow-pins.yml` gains an additional author-identity clause so the skip condition requires both commit-message match AND bot authorship (narrower, fewer false positives).
3. One new subsection in `docs/CI.md` names the three files whose self-refs must stay as `knirski/auto-pr/…@<SHA>` and explains why.

**Tech Stack:** GitHub Actions YAML, `actionlint` (via `bun run lint:workflows`), `scripts/smoke-update-pins-check-only.sh` (Lefthook harness for `check_only` mode).

**Reference spec:** `docs/superpowers/specs/2026-04-19-ci-modernization-audit-design.md` §3 (Area B).

**Branch:** `ai/ci-area-b-pin-cleanup` (per project convention: `ai/` prefix).

**Out of scope:**
- Touching any self-ref in the three load-bearing files (`auto-pr.yml`, `auto-pr-generate-reusable.yml`, `auto-pr-create-reusable.yml`). Those MUST remain as `knirski/auto-pr/…@<SHA>` — the updater keeps them fresh post-merge.
- Rewriting `update-pins.sh`. The spec explicitly leaves it as-is.
- Deleting the `update-workflow-pins` automation. §3.2.2 says it's not optional.

**Dependency ordering:** Per spec §8, Area B lands second (after Area F). This plan assumes F has already merged; `check.yml`'s line numbers may have shifted slightly since the audit — **anchor edits on textual context, not line numbers alone.**

---

## Background: what's load-bearing and what isn't

From spec §3.1, the ten self-refs fall into two groups:

**Load-bearing (must keep `knirski/auto-pr/…@<SHA>`):**
- `auto-pr.yml:34` → `auto-pr-generate-reusable.yml@<SHA>` (this workflow is a template copied into adopter repos by `auto-pr-init`)
- `auto-pr.yml:46` → `auto-pr-create-reusable.yml@<SHA>` (same reason)
- Every `uses:` inside `auto-pr-generate-reusable.yml` and `auto-pr-create-reusable.yml` (both are called via `workflow_call` from adopter repos)

**Convertible (can become `./`):**
- `check.yml:43` → `setup-runtime`. `check.yml` is a reusable called only by entry workflows in this repo; it never runs in an adopter's context. `./` resolves to the workflow's own repo → always correct.

---

## File Inventory

| Task | Files touched |
|---|---|
| 1 (convert `check.yml:43`) | `.github/workflows/check.yml` |
| 2 (harden loop prevention) | `.github/workflows/update-workflow-pins.yml` |
| 3 (document load-bearing set) | `docs/CI.md` |
| 4 (final verification) | none (CI + smoke scripts) |

---

## Task 0: Branch Setup

**Files:** none.

- [ ] **Step 1: Fresh branch from `main`**

```bash
git checkout main
git pull --ff-only
git checkout -b ai/ci-area-b-pin-cleanup
```

- [ ] **Step 2: Confirm clean tree**

Run: `git status`
Expected: `nothing to commit, working tree clean`

- [ ] **Step 3: Confirm Area F has merged (sanity)**

Run: `git log --oneline --grep='Area F' main -5`

If Area F commits are visible, proceed. If not, note that line numbers in subsequent edits refer to the post-Area-F tree; you may need to locate anchors textually rather than by line.

---

## Task 1: Convert `check.yml:43` setup-runtime to `./`

**Purpose:** `check.yml` is a same-repo reusable called only by entry workflows in `knirski/auto-pr`; it never runs from an adopter's repo. The `./` path syntax resolves against the workflow's own repo — which is this repo — so the `@<SHA>` pin adds no safety. Removing it shrinks the load-bearing pin set by one and deletes a comment that has misled past readers.

**Why the comment is stale:** The comment currently reads *"setup-runtime: use full path so callers don't need the action. Relative ./ would resolve to caller's repo."* This is only true for workflows executed in an adopter's repo. `check.yml` is never such a workflow. The comment's rationale does not apply here; it belongs only on `auto-pr.yml`, `auto-pr-generate-reusable.yml`, and `auto-pr-create-reusable.yml`.

**Files:**
- Modify: `.github/workflows/check.yml` — around line 40–44 (the `setup-runtime` step and its preceding comment)

---

- [ ] **Step 1: Read the current state of `check.yml:40-46`**

Open `.github/workflows/check.yml` and locate the two-line comment and the `setup-runtime` step. Current text (post-Area-F may have shifted line numbers slightly; anchor on the comment text):

```yaml
      # setup-runtime: use full path so callers don't need the action. Relative ./ would
      # resolve to caller's repo. Update @SHA when updating workflow refs (see auto-pr.yml).
      - name: Setup runtime (Node or alternative) with cache
        id: setup
        uses: knirski/auto-pr/.github/actions/setup-runtime@2f8296dd224c5f2cc7f44dceff2ac3b02ae4a6f5
```

- [ ] **Step 2: Replace the block**

Replace the five lines above with:

```yaml
      - name: Setup runtime (Node or alternative) with cache
        id: setup
        uses: ./.github/actions/setup-runtime
```

Both comment lines are deleted along with the `@<SHA>` pin.

- [ ] **Step 3: Run actionlint**

Run: `bun run lint:workflows`
Expected: exits 0.

- [ ] **Step 4: Run the local pin smoke-check**

Run: `bash scripts/smoke-update-pins-check-only.sh`
Expected: exits 0. The script validates that all remaining `knirski/auto-pr/…@<SHA>` self-refs share the same SHA and that the SHA is reachable. Removing one entry shouldn't break this invariant (the remaining refs in the three load-bearing files still share their own SHA).

If the script errors with a message about mixed SHAs or unreachable commits, the problem is not this edit — it's a pre-existing pin drift. Investigate separately; do not hack around it here.

- [ ] **Step 5: Confirm the pin count dropped by exactly one**

Run:
```bash
grep -rn "uses: knirski/auto-pr/" .github/workflows/ .github/actions/ | wc -l
```

Expected: the count is one less than it was on `main` before this edit. Spot-check:
```bash
grep -rn "uses: knirski/auto-pr/" .github/workflows/ .github/actions/
```

Expected output: only references inside `auto-pr.yml`, `auto-pr-generate-reusable.yml`, and `auto-pr-create-reusable.yml`. No other file.

If any other file shows up, investigate before committing — this plan's §Background lists the expected set explicitly.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/check.yml
git commit -m "ci(check): use ./ for setup-runtime; drop stale caller-resolution comment"
```

---

## Task 2: Harden loop prevention in `update-workflow-pins.yml`

**Purpose:** The current skip condition in `update-workflow-pins.yml` (lines 25–26 in the pre-Area-F tree, may have shifted slightly) is:

```yaml
    if: |
      github.repository == 'knirski/auto-pr' &&
      (github.event_name != 'push' || github.event.head_commit == null || !startsWith(github.event.head_commit.message, 'chore(workflows): update self-referential pins'))
```

This skips the job when a push arrives whose commit message starts with `chore(workflows): update self-referential pins` — the exact message the bot writes. The intent is loop prevention: the bot's own push should not retrigger the bot.

**The false-positive problem (spec §3.2.3):** A human whose commit message happens to start with that exact prefix would also be skipped. Unlikely but not impossible — e.g., a manual pin correction following the same naming convention.

**The fix:** Require *both* conditions to skip — commit-message match AND bot-authored. A human push with the magic prefix still runs.

**Why `github.event.head_commit.author.name` and not `github.actor`:** The pin updater pushes via a custom GitHub App token (see `update-workflow-pins.yml` lines 33–40). When that push triggers a workflow run, `github.actor` is set to the App's slug (e.g. `knirski-auto-pr[bot]`) — NOT `github-actions[bot]`. But the pin updater explicitly configures `git config user.name "github-actions[bot]"` before committing (line 58 of the workflow), so the commit's author name IS stable and known: `github-actions[bot]`. Checking `github.event.head_commit.author.name` uses a value we control deterministically. Spec §3.3 suggests `github.actor`; this plan refines that to the author-name check for the reason above. A diagnostic step below confirms the value before the hardening edit lands.

**Files:**
- Modify: `.github/workflows/update-workflow-pins.yml` — the `if:` block around lines 24–26 (pre-Area-F; post-Area-F line numbers unchanged since F didn't touch this file's `if:`).

---

- [ ] **Step 1: Confirm `github.event.head_commit.author.name` resolves to the expected value**

Run:
```bash
git log --grep='chore(workflows): update self-referential pins' --format='author_name=%an%n author_email=%ae' -3
```

Expected output: each commit shows `author_name=github-actions[bot]`. This confirms the bot's commits have `author.name` = `github-actions[bot]` in the git object itself (and by extension in the webhook payload field `github.event.head_commit.author.name`).

If any recent bot-pin commit shows a different `author.name`, use that value in Step 3 instead — and update the commit message to reflect what was picked.

- [ ] **Step 2: Read the current `if:` block for exact anchoring**

Read `.github/workflows/update-workflow-pins.yml` lines 22–28 (the `jobs.update-pins.if:` block). Current text:

```yaml
  update-pins:
    if: |
      github.repository == 'knirski/auto-pr' &&
      (github.event_name != 'push' || github.event.head_commit == null || !startsWith(github.event.head_commit.message, 'chore(workflows): update self-referential pins'))
    runs-on: ubuntu-24.04
```

- [ ] **Step 3: Add the author-name clause**

Replace the `if:` block with the hardened version:

```yaml
  update-pins:
    # Loop prevention requires BOTH conditions to skip:
    #   - commit message starts with the pin-updater prefix, AND
    #   - commit author is github-actions[bot] (set explicitly by this workflow in the Commit-and-push step).
    # A human commit that happens to reuse the prefix still runs.
    if: |
      github.repository == 'knirski/auto-pr' &&
      (github.event_name != 'push' ||
       github.event.head_commit == null ||
       !startsWith(github.event.head_commit.message, 'chore(workflows): update self-referential pins') ||
       github.event.head_commit.author.name != 'github-actions[bot]')
    runs-on: ubuntu-24.04
```

Logic recap for reviewers:
- **Bot push** (message matches, author is bot) → all four OR clauses false → `if:` false → **skip**. ✓
- **Human push with magic prefix** (message matches, author is human) → last OR clause true → `if:` true → **run**. ✓ (This is the bug §3.2.3 flags; now fixed.)
- **Normal human push** (message doesn't match) → third OR clause true → `if:` true → **run**. ✓

- [ ] **Step 4: actionlint passes**

Run: `bun run lint:workflows`
Expected: exits 0.

- [ ] **Step 5: Dry-check the expression with `gh` or a local eval**

The skip condition is purely a YAML expression; no runtime test is possible short of a real push. Sanity-check the syntax by running `actionlint` in `--verbose` mode if needed:

```bash
nix develop --command actionlint -verbose .github/workflows/update-workflow-pins.yml
```

Expected: no errors. The expression parses as valid GitHub Actions syntax.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/update-workflow-pins.yml
git commit -m "ci(update-workflow-pins): require bot authorship AND message prefix to skip"
```

---

## Task 3: Document the load-bearing set in `docs/CI.md`

**Purpose:** Spec §3.3 calls out that ADR 0004 motivates the pin automation but does not name *which* refs are load-bearing and *why*. Readers rediscover this periodically. Adding a short subsection eliminates that rediscovery cost.

**Where it goes:** `docs/CI.md` §"Workflow pin automation" has subsections:
1. "What is pinned how" (a table of pin kinds)
2. "Self-referential pins (knirski/auto-pr → knirski/auto-pr)"
3. "Third-party actions"
4. "Related docs"

Insert the new subsection **between (2) "Self-referential pins" and (3) "Third-party actions"**, titled **"Why this automation cannot be deleted"**.

**Files:**
- Modify: `docs/CI.md`

---

- [ ] **Step 1: Read the surrounding section**

Read `docs/CI.md` around lines 160–195 (the "Workflow pin automation" section). Locate the end of the "Self-referential pins" subsection (ends just before the `### Third-party actions` heading).

- [ ] **Step 2: Insert the new subsection**

Immediately above `### Third-party actions`, add:

```markdown
### Why this automation cannot be deleted

Three files contain self-referential `knirski/auto-pr/…@<SHA>` refs that **cannot** be converted to `./`. Each entry explains the constraint:

| File | Why `./` won't work |
|------|--------------------|
| [auto-pr.yml](../.github/workflows/auto-pr.yml) | Distributed verbatim into adopter repos by `npx auto-pr-init`. When it runs in an adopter's repo, `./` resolves to the adopter's checkout — which does not contain `auto-pr-generate-reusable.yml` or `auto-pr-create-reusable.yml`. The full `knirski/auto-pr/…@<SHA>` ref points GitHub at this repo explicitly. |
| [auto-pr-generate-reusable.yml](../.github/workflows/auto-pr-generate-reusable.yml) | Externally called via `workflow_call` from `auto-pr.yml` in adopter repos. The adopter's runner performs the checkout; `./` resolves against the adopter's tree. Every composite-action `uses:` inside this file must pin `knirski/auto-pr/.github/actions/…@<SHA>` for the same reason. |
| [auto-pr-create-reusable.yml](../.github/workflows/auto-pr-create-reusable.yml) | Same as above. |

Concretely: these three files have no way to reach `.github/actions/*` in *this* repo except by SHA-pinned full path. Any internal-only workflow (`check.yml`, `integration.yml`, `check-workflows.yml`, etc.) can and should use `./`. The post-merge pin-updater (`update-workflow-pins.yml`) exists solely to keep the three load-bearing files' pins advancing after each merge to `main`; it is not discretionary.

Rationale and history: [ADR 0004 — workflow-pin automation](adr/0004-workflow-pin-automation.md).
```

- [ ] **Step 3: Update the cross-reference in the preceding subsection (optional but polishing)**

Within the existing "Self-referential pins" subsection, the sentence that begins *"All matching `uses:` lines must share exactly one 40-character SHA…"* could benefit from a forward-link to the new subsection. This is optional; skip if it breaks line-by-line review.

If adding: at the end of that paragraph, append `See below for *which* files must carry these pins.`

- [ ] **Step 4: Render and spot-check the rendered docs**

Run (if Bun and the website tooling are installed):
```bash
cd website && bun run dev
```

Navigate to the CI page in the browser; confirm the new subsection renders with the table intact and all three links resolve. If the website isn't running, spot-check the raw markdown for table formatting:

```bash
grep -A 10 "Why this automation cannot be deleted" docs/CI.md
```

Expected: the table shows three rows, each with a file name link and a one-sentence reason.

- [ ] **Step 5: Verify internal links resolve**

```bash
for link in \
  .github/workflows/auto-pr.yml \
  .github/workflows/auto-pr-generate-reusable.yml \
  .github/workflows/auto-pr-create-reusable.yml \
  docs/adr/0004-workflow-pin-automation.md; do
  test -f "$link" && echo "OK: $link" || echo "BROKEN: $link"
done
```

Expected: every line prints `OK:`. The ADR path is `docs/adr/0004-workflow-pin-automation.md` (verified).

- [ ] **Step 6: Commit**

```bash
git add docs/CI.md
git commit -m "docs(ci): document which self-referential pins cannot be deleted, and why"
```

---

## Task 4: Final Verification and PR

**Files:** none (CI + smoke scripts + gh commands).

---

- [ ] **Step 1: Full local lint**

Run: `bun run lint:workflows`
Expected: exits 0.

- [ ] **Step 2: Pin smoke-check**

Run: `bash scripts/smoke-update-pins-check-only.sh`
Expected: exits 0 with `changed=false` in the `$GITHUB_OUTPUT` mock (the script sets `INPUT_CHECK_ONLY=true` so no writes happen). Validates that every remaining self-ref still shares one SHA and that the SHA is reachable.

- [ ] **Step 3: Diff summary**

Run:
```bash
git log --oneline main..HEAD
git diff main...HEAD --stat
```

Expected output:
- 3 commits (Tasks 1–3), each scoped to one file.
- `--stat` shows changes in `.github/workflows/check.yml` (small), `.github/workflows/update-workflow-pins.yml` (small), `docs/CI.md` (new subsection).

- [ ] **Step 4: Push and open PR**

```bash
git push -u origin ai/ci-area-b-pin-cleanup

gh pr create --title "ci: Area B — pin-automation cleanup (convert one ref, harden skip, document load-bearing set)" --body "$(cat <<'EOF'
## Summary

Implements Area B from the CI modernisation audit (`docs/superpowers/specs/2026-04-19-ci-modernization-audit-design.md` §3). Three small edits:

1. **`check.yml` → `./`.** `check.yml` is a same-repo reusable called only by internal entry workflows; it never runs in an adopter's context, so `./.github/actions/setup-runtime` always resolves correctly. Drops one self-ref from the load-bearing set (now: three files instead of four). Stale caller-resolution comment deleted.
2. **`update-workflow-pins.yml` loop prevention hardened.** The skip condition now requires BOTH the commit-message prefix AND `github.event.head_commit.author.name == 'github-actions[bot]'`. A human using the magic prefix no longer silently skips the updater. (`github.event.head_commit.author.name` is used instead of `github.actor` because the bot pushes via a custom App token — `github.actor` is then the App slug, not `github-actions[bot]` — but `author.name` is set explicitly in the workflow's Commit-and-push step.)
3. **`docs/CI.md` new subsection.** "Why this automation cannot be deleted" enumerates the three load-bearing files and the constraint that forces each one's self-ref. Readers no longer rediscover this.

Landing order per spec §8: Area B lands second, after Area F merged.

## Test plan

- [ ] `bun run lint:workflows` passes locally
- [ ] `bash scripts/smoke-update-pins-check-only.sh` exits 0
- [ ] CI on this PR goes green (`ci / check` validates the pin invariant via `check_only: true`)
- [ ] After merge: observe one `update-workflow-pins` run fire, push a `chore(workflows): update self-referential pins to <sha>` commit to main, and then observe the NEXT run of the workflow on that pushed commit skip (loop prevention still works)
- [ ] Docs rendered: the new subsection appears under "Workflow pin automation" with the three-row table intact

## Risk

- **Loop-prevention hardening risk:** If `github.event.head_commit.author.name` for bot commits ever drifts (e.g. someone edits the Commit-and-push step's `git config user.name`), the loop prevention silently fails. Mitigation: the `git config` call is now effectively load-bearing; if future edits touch it, the author-name clause in `update-workflow-pins.yml:if:` must be updated in the same commit.
- **Line-number drift risk:** The plan's file:line references assume Area F has merged. Edits anchor on textual context, not line numbers, so drift is tolerable.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Watch CI**

Run: `gh pr checks --watch`
Expected: all required checks green. `ci / check` is the critical one — it validates every remaining self-ref still shares one SHA.

If `ci / check` fails with a pin-validation error, the likely cause is a stale SHA in one of the three load-bearing files (pre-existing drift, not introduced by this PR). Address by running the pin updater locally:

```bash
INPUT_CHECK_ONLY=false INPUT_TARGET_SHA=$(git rev-parse HEAD) bash .github/actions/update-workflow-pins/update-pins.sh
```

…and committing the result. (This is a rare escape hatch; if you find yourself here on a routine Area-B PR, something is off — investigate before committing.)

- [ ] **Step 6: Post-merge verification**

After the PR merges to `main`:

1. Observe that `update-workflow-pins.yml` fires on the merge commit and pushes a `chore(workflows): update self-referential pins to <new-sha>` commit.
2. Observe that the workflow run triggered by *that* bot commit is **skipped** (the hardened `if:` still catches the loop).
3. On the next unrelated push to `main` that touches `.github/workflows/**` or `.github/actions/**`, observe the updater fires normally.

If any of these post-merge checks fail, revert immediately and open an issue — the loop is either newly-live or newly-broken.

---

## Success Criteria

Per spec §9 Area B:

- `check.yml` uses `./` for `setup-runtime` (verified: `grep "knirski/auto-pr/" .github/workflows/check.yml` returns nothing).
- `update-workflow-pins.yml:if:` includes the author-name clause.
- `docs/CI.md` §"Workflow pin automation" contains the new subsection naming the three load-bearing files.
- Post-merge: bot-pushed pin-update commit still triggers a run that correctly skips itself.

## Post-merge

1. Observe the post-merge loop-prevention verification succeeds (Task 4 Step 6).
2. Hand off to Area A: `docs/superpowers/plans/<date>-ci-area-a-consolidate-entry-workflows.md` (to be written). Area A requires branch-protection migration, so it should merge on its own — not mixed with any other PR.
