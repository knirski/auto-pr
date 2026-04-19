# CI Area D — Nix Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate duplication in the Nix CI setup by extracting a `setup-nix-with-cache` composite action used at all three Nix call sites, harmonise the cache-key shape so cross-hydration works across workflows, resolve the ambiguity around the `Trigger check on new commit` step in `nix.yml`, and disambiguate `DeterminateSystems/update-flake-lock` from the `cachix/install-nix-action` choice recorded in ADR 0006.

**Architecture:**
- New composite action `.github/actions/setup-nix-with-cache/action.yml` does two things: install Nix (`cachix/install-nix-action@v31.10.3`) + restore/save store cache (`nix-community/cache-nix-action@v7`). Checkout stays per-site — each call site has different checkout options (refs, tokens, fetch-depth) and that parameterisation isn't worth adding to the composite.
- Three call sites updated: `nix.yml` `bun-nix` job, `nix.yml` `build` matrix job, `update-flake-lock.yml`.
- `bun-nix` job GAINS caching as a side effect (it currently installs Nix without caching). This is a small but real improvement to typical wall-time.
- Cache key unified to `nix-store-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('**/*.nix', '**/bun.lock', '**/flake.lock') }}`. Distinct across the matrix (x86_64-linux → `Linux-X64`, aarch64-linux → `Linux-ARM64`, aarch64-darwin → `macOS-ARM64`) and shares a prefix with `update-flake-lock.yml` so that workflow's cache hits the same entries the `build` matrix job populated.

**Tech Stack:** GitHub Actions YAML, `cachix/install-nix-action@v31.10.3`, `nix-community/cache-nix-action@v7`, `actionlint`.

**Reference spec:** `docs/superpowers/specs/2026-04-19-ci-modernization-audit-design.md` §4 (Area D).

**Branch:** `ai/ci-area-d-nix-cleanup` (per project convention: `ai/` prefix).

**Dependency ordering:** Per spec §8, Area D lands fourth (after F, B, A). This plan assumes F, B, and A have merged. In particular, `ci.yml` is the consolidated form (no legacy entries); `nix.yml`'s `Trigger check on new commit` step references `ci.yml` which still exists post-A. Line numbers in this plan reflect the post-A tree — anchor edits on textual context where possible.

**Out of scope:**
- Evaluating `mkBunDerivation` as a replacement for `bun2nix` (spec §4.4 explicit out-of-scope; needs its own research spec).
- Changing the `build` matrix shape (systems / runners).
- Touching `flake.nix`, `default.nix`, `bun.nix`, or `flake.lock`.
- Replacing upstream Nix (`cachix/install-nix-action`) with Determinate Nix — ADR 0006 ruled on that; this plan only clarifies the docs.

---

## Background: where duplication currently lives

Three sites install Nix and (in two of the three) restore the store cache, with drift between them:

| Site | Install Nix | Cache store | Cache key prefix |
|---|---|---|---|
| `nix.yml` `bun-nix` job | `cachix/install-nix-action@…# v31` | (none — cache missing) | n/a |
| `nix.yml` `build` matrix job | `cachix/install-nix-action@…# v31` | `nix-community/cache-nix-action@v7` | `nix-${{ matrix.system }}-…` |
| `update-flake-lock.yml` | `cachix/install-nix-action@…# v31.10.3` | `nix-community/cache-nix-action@v7` | `nix-${{ runner.os }}-…` |

Three drifts:
1. Version comment on `cachix/install-nix-action` (same SHA; different comment text).
2. `bun-nix` installs Nix but doesn't cache — every run cold-starts the store.
3. Cache-key prefix disagreement (`matrix.system` vs `runner.os`) blocks cross-hydration between `build` runs and `update-flake-lock` runs.

Post-Area-D: one composite pinned once, consistent comment, consistent cache-key, and `bun-nix` gets caching for free.

---

## File Inventory

| Task | Files touched |
|---|---|
| 1 (create composite) | `.github/actions/setup-nix-with-cache/action.yml` (new) |
| 2 (migrate `build`) | `.github/workflows/nix.yml` (build job) |
| 3 (migrate `bun-nix`) | `.github/workflows/nix.yml` (bun-nix job) |
| 4 (migrate `update-flake-lock`) | `.github/workflows/update-flake-lock.yml` |
| 5 (investigate trigger step) | `.github/workflows/nix.yml` (either delete step or annotate) |
| 6 (docs clarifier) | `docs/CI.md` (new short paragraph in §Nix or near ADR 0006 reference) |
| 7 (final verification) | none (CI + actionlint) |

---

## Task 0: Branch Setup

**Files:** none.

- [ ] **Step 1: Fresh branch from `main`**

```bash
git checkout main
git pull --ff-only
git checkout -b ai/ci-area-d-nix-cleanup
```

- [ ] **Step 2: Confirm Areas F, B, A merged**

```bash
git log --oneline --grep='Area F\|Area B\|Area A Phase 2' main -10
```

Expected: commits from all three areas visible. If any is missing, STOP and complete those first — this plan assumes `ci.yml` is the consolidated form.

- [ ] **Step 3: Clean tree**

Run: `git status`
Expected: `nothing to commit, working tree clean`

---

## Task 1: Create the `setup-nix-with-cache` composite action

**Purpose:** Single source of truth for "install Nix + restore store cache." Replaces install+cache duplication at three call sites.

**Files:** `.github/actions/setup-nix-with-cache/action.yml` (new).

**Design notes:**
- No inputs. All three call sites want identical behavior.
- No checkout — call sites retain their own checkout steps (each has different refs/tokens/fetch-depth).
- Pins harmonised: `cachix/install-nix-action@96951a368ba55167b55f1c916f7d416bac6505fe # v31.10.3` (same SHA both sites currently use; consistent comment).
- Cache key uses `runner.os` + `runner.arch` for a uniform shape across call sites.

---

- [ ] **Step 1: Create the directory and action file**

Run:
```bash
mkdir -p .github/actions/setup-nix-with-cache
```

Create `.github/actions/setup-nix-with-cache/action.yml`:

```yaml
# Composite action: install Nix and restore/save the Nix store cache.
# Used by nix.yml (bun-nix + build jobs) and update-flake-lock.yml.
# Does NOT include checkout — call sites have different checkout options (refs, tokens, fetch-depth).
# See docs/CI.md §Nix and ADR 0006 (upstream Nix).

name: Setup Nix with cache
description: Install upstream Nix (cachix/install-nix-action) and restore/save the Nix store cache.

runs:
  using: composite
  steps:
    - name: Install Nix
      uses: cachix/install-nix-action@96951a368ba55167b55f1c916f7d416bac6505fe # v31.10.3
      with:
        extra_nix_config: "experimental-features = nix-command flakes auto-allocate-uids"

    - name: Restore and save Nix store
      uses: nix-community/cache-nix-action@7df957e333c1e5da7721f60227dbba6d06080569 # v7
      with:
        primary-key: nix-store-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('**/*.nix', '**/bun.lock', '**/flake.lock') }}
        restore-prefixes-first-match: nix-store-${{ runner.os }}-${{ runner.arch }}-
```

- [ ] **Step 2: Verify the file parses**

Run: `bun run lint:workflows`
Expected: exits 0. `actionlint` validates composite action YAML.

- [ ] **Step 3: Inspect against conventions**

Run:
```bash
grep -E "uses: [^./]" .github/actions/setup-nix-with-cache/action.yml
```

Expected output: exactly two lines, both with `@<40-char-SHA> # vX.Y.Z` form (per Area F item 8, which Area D inherits). Verify the SHAs are 40 lowercase hex.

- [ ] **Step 4: Commit**

```bash
git add .github/actions/setup-nix-with-cache/
git commit -m "ci(actions): add setup-nix-with-cache composite (install + cache)"
```

---

## Task 2: Migrate `nix.yml` `build` matrix job to the composite

**Purpose:** Replace install+cache duplication in the `build` job with a single `uses: ./.github/actions/setup-nix-with-cache` step. Cache key shape changes from `nix-${{ matrix.system }}-…` → `nix-store-${{ runner.os }}-${{ runner.arch }}-…`.

**Cache invalidation note:** The first run after this PR merges will NOT hit the cache (key prefix changed). Subsequent runs will hit. This is a one-time cold-build on each of the three matrix systems.

**Files:** `.github/workflows/nix.yml` — the `build` job's Install Nix + Restore and save Nix store steps.

---

- [ ] **Step 1: Read the current `build` job**

Read `.github/workflows/nix.yml`. Locate the `build:` job (around line 110–180 in the current file). Current steps include:

```yaml
      - name: Install Nix
        uses: cachix/install-nix-action@96951a368ba55167b55f1c916f7d416bac6505fe # v31
        with:
          extra_nix_config: "experimental-features = nix-command flakes auto-allocate-uids"

      - name: Restore and save Nix store
        uses: nix-community/cache-nix-action@7df957e333c1e5da7721f60227dbba6d06080569 # v7
        with:
          primary-key: nix-${{ matrix.system }}-${{ hashFiles('**/*.nix', '**/bun.lock', '**/flake.lock') }}
          restore-prefixes-first-match: nix-${{ matrix.system }}-
```

- [ ] **Step 2: Replace with composite call**

Replace the two steps above with a single step:

```yaml
      - name: Setup Nix with cache
        uses: ./.github/actions/setup-nix-with-cache
```

Keep the surrounding `Checkout` step (above) and `Nix flake check` step (below) unchanged.

- [ ] **Step 3: Verify actionlint**

Run: `bun run lint:workflows`
Expected: exits 0.

- [ ] **Step 4: Self-referential pin smoke-check**

Run: `bash scripts/smoke-update-pins-check-only.sh`
Expected: exits 0. Adding a new same-repo composite (`./.github/actions/setup-nix-with-cache`) doesn't introduce any `knirski/auto-pr/…@<SHA>` references; same-repo `./` uses don't participate in the self-ref pin set.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/nix.yml
git commit -m "ci(nix): migrate build job to setup-nix-with-cache composite"
```

---

## Task 3: Migrate `nix.yml` `bun-nix` job to the composite (and gain caching)

**Purpose:** The `bun-nix` job currently installs Nix without caching, meaning every run cold-rebuilds the store. Adding the composite gives it the same cache as the `build` job — free win.

**Files:** `.github/workflows/nix.yml` — the `bun-nix` job's Install Nix step.

---

- [ ] **Step 1: Read the current `bun-nix` job**

Read `.github/workflows/nix.yml`. Locate the `bun-nix:` job (lines ~30–105). The Install Nix step:

```yaml
      - name: Install Nix
        uses: cachix/install-nix-action@96951a368ba55167b55f1c916f7d416bac6505fe # v31
        with:
          extra_nix_config: "experimental-features = nix-command flakes auto-allocate-uids"
```

There is NO `Restore and save Nix store` step in this job currently.

- [ ] **Step 2: Replace with composite call**

Replace the Install Nix step with:

```yaml
      - name: Setup Nix with cache
        uses: ./.github/actions/setup-nix-with-cache
```

The step name changes from "Install Nix" → "Setup Nix with cache." Surrounding steps (Checkout above, Setup Bun below) are unchanged.

- [ ] **Step 3: Verify actionlint**

Run: `bun run lint:workflows`
Expected: exits 0.

- [ ] **Step 4: Spot-check the two jobs now share the composite**

Run:
```bash
grep -n "setup-nix-with-cache" .github/workflows/nix.yml
```

Expected: two matches (bun-nix and build jobs).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/nix.yml
git commit -m "ci(nix): migrate bun-nix job to setup-nix-with-cache (adds caching)"
```

---

## Task 4: Migrate `update-flake-lock.yml` to the composite

**Purpose:** Complete the migration. After this task, all three install+cache sites use the same composite — the cache key harmonisation benefits update-flake-lock runs too (they'll cross-hydrate with `build`'s Linux-X64 cache).

**Files:** `.github/workflows/update-flake-lock.yml`

---

- [ ] **Step 1: Read the current file**

Current steps (lines ~22–44):

```yaml
      - name: Install Nix
        uses: cachix/install-nix-action@96951a368ba55167b55f1c916f7d416bac6505fe # v31.10.3
        with:
          extra_nix_config: "experimental-features = nix-command flakes auto-allocate-uids"

      - name: Restore and save Nix store
        uses: nix-community/cache-nix-action@7df957e333c1e5da7721f60227dbba6d06080569 # v7
        with:
          primary-key: nix-${{ runner.os }}-${{ hashFiles('**/*.nix', '**/bun.lock', '**/flake.lock') }}
          restore-prefixes-first-match: nix-${{ runner.os }}-
```

- [ ] **Step 2: Replace with composite call**

Replace the two steps above with:

```yaml
      - name: Setup Nix with cache
        uses: ./.github/actions/setup-nix-with-cache
```

Surrounding steps (Checkout above, `DeterminateSystems/update-flake-lock` below) stay unchanged.

- [ ] **Step 3: Verify all three migrations visible**

```bash
grep -rn "setup-nix-with-cache" .github/workflows/
```

Expected: three matches — `nix.yml` (2) and `update-flake-lock.yml` (1).

- [ ] **Step 4: Verify no stray `cachix/install-nix-action` direct usage remains**

```bash
grep -rn "cachix/install-nix-action" .github/workflows/ .github/actions/
```

Expected: exactly ONE match — inside `.github/actions/setup-nix-with-cache/action.yml`. Every other use is now the composite.

Similarly verify `nix-community/cache-nix-action`:
```bash
grep -rn "nix-community/cache-nix-action" .github/workflows/ .github/actions/
```

Expected: exactly ONE match — inside the composite.

- [ ] **Step 5: actionlint**

Run: `bun run lint:workflows`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/update-flake-lock.yml
git commit -m "ci(update-flake-lock): migrate to setup-nix-with-cache composite"
```

---

## Task 5: Investigate and resolve `nix.yml` `Trigger check on new commit` step

**Purpose:** Spec §4.2.3 flags an ambiguity. The top of `nix.yml` comments:

> "Uses GitHub App token when push_allowed so the push triggers CI on the new commit (GITHUB_TOKEN pushes do not trigger workflows)."

…which claims the App-token push alone triggers CI. Yet the `bun-nix` job has a post-push step that explicitly dispatches `ci.yml`:

```yaml
      - name: Trigger check on new commit
        if: steps.bun-nix.outputs.changed == 'true' && inputs.push_allowed
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
          REF: ${{ inputs.ref || github.ref }}
        run: |
          BRANCH="${REF#refs/heads/}"
          if ! gh workflow run ci.yml --ref "$BRANCH"; then
            echo "::error::Failed to trigger ci.yml. Ensure App has Actions: Read and write permission."
            exit 1
          fi
```

Either the top-of-file comment is right and the step is redundant, or the step is load-bearing for a reason not recorded in code. This task resolves the ambiguity via test-driven investigation.

**Files:** `.github/workflows/nix.yml` — either delete the step OR add an explanatory inline comment.

---

- [ ] **Step 1: Search git history for rationale**

Run:
```bash
git log --all --oneline -- .github/workflows/nix.yml | head -15
git log -p --all -- .github/workflows/nix.yml 2>&1 | grep -B 2 -A 5 "Trigger check on new commit\|gh workflow run ci.yml" | head -80
```

Read the output. Look for any commit message or PR discussion explaining why the explicit dispatch was added. Common reasons to consider:
- Original added in a specific PR with an explanation.
- Workaround for a GitHub Actions quirk that has since been fixed.
- Bridge to handle `workflow_dispatch`-triggered runs from `update-bun-nix.yml`.

Capture any rationale found in a note for Step 3 below.

- [ ] **Step 2: Attempt deletion + test**

Delete the `Trigger check on new commit` step from `.github/workflows/nix.yml`. (Leave the `Fail on bun.nix mismatch (fork)` step below it in place.)

Run `actionlint` (via `bun run lint:workflows`). Expected: exits 0.

**Do not commit yet.** Verification happens in the PR, not locally — we need a real CI run where `bun.nix` legitimately needs regeneration.

Open a small test PR (separately, NOT on the Area D branch — a throwaway PR with a minor `bun.lock` change that forces bun.nix to differ). This test PR will trigger the `nix` job in consolidated `ci.yml`, which calls `nix.yml` `bun-nix`, which should now push `bun.nix` and expect the natural-trigger behavior (no explicit `gh workflow run`).

Observe:
- Does the App-token push to the PR branch trigger `pull_request.synchronize` → ci.yml re-run on the PR → all checks re-run on the new commit?
- If YES → the explicit step WAS redundant; the deletion is correct. Proceed to Step 4.
- If NO → the explicit step WAS load-bearing; restore it (Step 3).

**Logistical note:** the throwaway PR is a diagnostic. Close it without merging once the experiment is complete.

- [ ] **Step 3: Restore with an explanatory comment (ONLY IF Step 2 showed the step is load-bearing)**

If the experiment showed the natural trigger doesn't fire (i.e., after the App-token push, the PR's CI did NOT re-run), restore the step with a descriptive comment. Replace the originally-deleted block with:

```yaml
      # Explicit re-dispatch: when this job runs inside ci.yml's `nix` job on a PR event,
      # the App-token push to the PR head produces a new commit but does NOT reliably
      # trigger pull_request.synchronize for the PR — observed {date of Step 2 experiment}.
      # Manual dispatch of ci.yml on the new commit preserves the status-check refresh
      # that branch protection needs. Do not delete without re-running the diagnostic.
      - name: Trigger check on new commit
        if: steps.bun-nix.outputs.changed == 'true' && inputs.push_allowed
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
          REF: ${{ inputs.ref || github.ref }}
        run: |
          BRANCH="${REF#refs/heads/}"
          if ! gh workflow run ci.yml --ref "$BRANCH"; then
            echo "::error::Failed to trigger ci.yml. Ensure App has Actions: Read and write permission."
            exit 1
          fi
```

Substitute the date of your experiment into `{date of Step 2 experiment}`.

- [ ] **Step 4: Update the top-of-file comment regardless of outcome**

Whether the step was deleted (Step 2) or restored (Step 3), the top-of-file comment about App-token pushes needs refining. Read `.github/workflows/nix.yml` lines 1–10:

```yaml
# Reusable workflow: Nix build with bun.nix auto-update.
# Called by ci-nix.yml and update-bun-nix.yml.
#
# Uses GitHub App token when push_allowed so the push triggers CI on the new commit
# (GITHUB_TOKEN pushes do not trigger workflows). Same App as auto-pr (APP_ID, APP_PRIVATE_KEY).
```

Update:
- "Called by ci-nix.yml" is STALE post-Area-A. Replace with "Called by ci.yml's `nix` job and update-bun-nix.yml."
- The comment's claim about "push triggers CI on the new commit" should reflect the Task 5 experimental outcome:
  - If Step 2 deleted the explicit step: leave the comment as-is (it now describes reality).
  - If Step 3 restored the explicit step: append "The `Trigger check on new commit` step below is retained — see its inline comment for the reason the natural trigger isn't sufficient."

Produces:

```yaml
# Reusable workflow: Nix build with bun.nix auto-update.
# Called by ci.yml's `nix` job and update-bun-nix.yml.
#
# Uses GitHub App token when push_allowed so the push triggers CI on the new commit
# (GITHUB_TOKEN pushes do not trigger workflows). Same App as auto-pr (APP_ID, APP_PRIVATE_KEY).
# {If Step 3 restored the explicit step, append: The `Trigger check on new commit` step
# below is retained — see its inline comment for the reason the natural trigger isn't sufficient.}
```

- [ ] **Step 5: actionlint**

Run: `bun run lint:workflows`
Expected: exits 0.

- [ ] **Step 6: Commit**

Pick the commit message based on outcome:

**If Step 2 deleted the step:**
```bash
git add .github/workflows/nix.yml
git commit -m "ci(nix): remove redundant Trigger check on new commit (App-token push already triggers CI)"
```

**If Step 3 restored the step:**
```bash
git add .github/workflows/nix.yml
git commit -m "ci(nix): annotate Trigger check on new commit with the reason it must stay"
```

---

## Task 6: Document `DeterminateSystems/update-flake-lock` vs ADR 0006

**Purpose:** ADR 0006 chose upstream Nix (`cachix/install-nix-action`) over Determinate Nix. `update-flake-lock.yml` uses `DeterminateSystems/update-flake-lock` — which LOOKS like it contradicts ADR 0006 but doesn't (that action is a lockfile utility, not an installer). Readers periodically flag this as an inconsistency. One paragraph in `docs/CI.md` §Nix resolves it.

**Files:** `docs/CI.md`

---

- [ ] **Step 1: Locate the Nix-related section**

Read `docs/CI.md`; the relevant section is near line 83 (a paragraph about `ci-nix.yml` using upstream Nix) and line 148 (`## Troubleshooting`). Post-Area-A, the paragraph at line 83 likely no longer mentions `ci-nix.yml` by name — it should say "the `nix` job in `ci.yml`" instead.

Check:
```bash
grep -n "DeterminateSystems\|cachix/install-nix\|upstream Nix\|ADR 0006\|update-flake-lock" docs/CI.md
```

Identify where the new paragraph slots in most naturally. Options:
- Append to the paragraph about upstream Nix (line ~83).
- Create a new subsection near §Workflow pin automation, titled "Tools that wrap Nix vs tools that install Nix."

Preferred: append to the existing paragraph — one fewer subsection.

- [ ] **Step 2: Insert the clarifier**

At the end of the paragraph that discusses upstream Nix (the one mentioning `cachix/install-nix-action`), append:

```markdown
Separately, [update-flake-lock.yml](../.github/workflows/update-flake-lock.yml) runs [DeterminateSystems/update-flake-lock](https://github.com/DeterminateSystems/update-flake-lock) — a **single-purpose lockfile-refresh utility**, not a Nix installer. That workflow still installs upstream Nix via the `setup-nix-with-cache` composite before running the refresh action. Using the Determinate *action* does not reopen [ADR 0006](adr/0006-nix-ci-upstream-and-caching.md)'s choice of Determinate's *installer*.
```

Adjust the prose to fit the surrounding sentence flow; the key content is: "update-flake-lock is a lockfile util, not an installer, ADR 0006 stands."

- [ ] **Step 3: Verify links resolve**

```bash
for p in \
  .github/workflows/update-flake-lock.yml \
  docs/adr/0006-nix-ci-upstream-and-caching.md; do
  test -f "$p" && echo "OK: $p" || echo "BROKEN: $p"
done
```

Expected: both print `OK:`.

- [ ] **Step 4: Commit**

```bash
git add docs/CI.md
git commit -m "docs(ci): clarify DeterminateSystems/update-flake-lock is a utility, not an installer"
```

---

## Task 7: Final Verification and PR

**Files:** none.

---

- [ ] **Step 1: Full actionlint**

Run: `bun run lint:workflows`
Expected: exits 0.

- [ ] **Step 2: Inventory the changes**

```bash
git log --oneline main..HEAD
git diff main...HEAD --stat
```

Expected: 5–6 commits (1 composite create + 3 migrations + 1 trigger-step resolution + 1 docs), modifying `.github/actions/setup-nix-with-cache/action.yml` (new), `.github/workflows/nix.yml`, `.github/workflows/update-flake-lock.yml`, `docs/CI.md`.

- [ ] **Step 3: Verify the invariants**

```bash
echo "=== cachix/install-nix-action usages (expect 1) ==="
grep -rn "cachix/install-nix-action" .github/

echo "=== nix-community/cache-nix-action usages (expect 1) ==="
grep -rn "nix-community/cache-nix-action" .github/

echo "=== setup-nix-with-cache callers (expect 3) ==="
grep -rn "setup-nix-with-cache" .github/workflows/

echo "=== Remaining nix-<prefix>- cache keys (expect 0) ==="
grep -rn "primary-key: nix-[^s]" .github/
```

Expected:
- `cachix/install-nix-action`: 1 match (inside the composite).
- `nix-community/cache-nix-action`: 1 match (inside the composite).
- `setup-nix-with-cache`: 3 matches (2 in `nix.yml`, 1 in `update-flake-lock.yml`).
- Remaining `nix-<prefix>-` cache keys: 0 matches (all harmonised to `nix-store-`).

- [ ] **Step 4: Push and open PR**

```bash
git push -u origin ai/ci-area-d-nix-cleanup

gh pr create --title "ci: Area D — unify Nix setup into a single composite, harmonise cache keys" --body "$(cat <<'EOF'
## Summary

Implements Area D from the CI modernisation audit (`docs/superpowers/specs/2026-04-19-ci-modernization-audit-design.md` §4).

- **New composite:** `.github/actions/setup-nix-with-cache` wraps `cachix/install-nix-action@v31.10.3` + `nix-community/cache-nix-action@v7`. Pinned to SHAs consistent with the rest of the repo.
- **Three call sites migrated:** `nix.yml` `bun-nix` job (gains caching as a bonus), `nix.yml` `build` matrix job, `update-flake-lock.yml`.
- **Cache key harmonised** to `nix-store-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('**/*.nix', '**/bun.lock', '**/flake.lock') }}`. Prefix is uniform across all three call sites, so `update-flake-lock` runs can cross-hydrate from the `build` matrix's Linux-X64 cache.
- **`Trigger check on new commit` step in `nix.yml`:** {CHOOSE ONE of the two lines below to keep, delete the other}
  - Removed after verification that the App-token push triggers `pull_request.synchronize` naturally.
  - Retained with an inline comment explaining the observation that the natural trigger did NOT fire, making the explicit dispatch load-bearing.
- **Docs clarifier:** `docs/CI.md` now notes that `DeterminateSystems/update-flake-lock` is a lockfile-refresh *utility*, not a *Nix installer*, and does not reopen ADR 0006's choice.

### Cache invalidation note

The cache-key prefix change (`nix-<matrix.system>-…` → `nix-store-<os>-<arch>-…`) invalidates existing caches. The first run on each matrix system cold-builds the Nix store; subsequent runs hit the new cache. No correctness impact.

### Bonus: `bun-nix` now caches

The `bun-nix` job previously installed Nix without using `cache-nix-action`. It now inherits the composite's cache. Expect a small wall-time improvement for bun.nix regeneration on cached runs.

## Out of scope

- `mkBunDerivation` investigation (spec §4.4; separate research spec).
- Replacing upstream Nix with Determinate Nix (ADR 0006 stands).

## Test plan

- [ ] `bun run lint:workflows` passes
- [ ] CI goes green on this PR (triggers `nix` job via `ci.yml`'s path filter — `bun.lock` and `**/*.nix` both match)
- [ ] Observe `nix` job on PR: three matrix systems (x86_64-linux, aarch64-linux, aarch64-darwin) + bun-nix all run
- [ ] Post-merge: next `update-flake-lock` weekly cron run uses the new composite; cache key matches the `build` matrix's Linux-X64 (verify in logs — key should be `nix-store-Linux-X64-<hash>`)
- [ ] The `Trigger check on new commit` investigation (Task 5) completed with documented outcome

## Risk

- **First-run cold cache:** each of the three matrix runs rebuilds the Nix store once. Mitigation: none needed; this is a one-time cost.
- **`bun-nix` caching edge case:** the job pushes `bun.nix` changes. After a push, the next PR run's cache key (hash includes `bun.nix` via `**/*.nix`) misses; this is expected and not a regression (it happens every time `bun.nix` is regenerated).
- **Composite action resolution in `act` local CI:** adding a new composite action path; `act` should resolve it normally. Verified by `actionlint` + typical `act` semantics.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Watch CI**

Run: `gh pr checks --watch`
Expected: `CI / gate` green. `nix` job log shows the composite's Install Nix + Restore/save store steps on all three matrix systems.

Inspect one matrix run's cache step log to confirm the new key shape:
- Expected `primary-key: nix-store-Linux-X64-<40-hex>` (or ARM64 / macOS variant).

- [ ] **Step 6: Merge**

Once approved and green, merge normally.

---

## Success Criteria

Per spec §9 Area D:

- `setup-nix-with-cache` composite in use at all three call sites. ✓ (Task 7 Step 3 grep verifies 3 callers.)
- Cache-key prefix unified to `nix-store-…`. ✓ (Task 7 Step 3 grep verifies no other prefixes remain.)
- `nix.yml:88-98` either deleted or commented with rationale. ✓ (Task 5 outcome.)
- `docs/CI.md` disambiguates ADR 0006 re: DeterminateSystems. ✓ (Task 6.)
- `update-bun-nix.yml` retained as named dispatcher. ✓ (Not touched.)

## Post-merge Observation

Watch for:
- `build` matrix wall-time on the first post-merge PR (expected: modest increase on first run due to cold cache; baseline on second run).
- `update-flake-lock` weekly cron run (next Sunday 00:00 UTC): verify in the log that the cache key resolves to `nix-store-Linux-X64-<hash>` and that it hits an entry populated by a prior `build` matrix run on Linux-X64.
- `bun-nix` job wall-time on a bun.lock-touching PR (expected: modest improvement vs. pre-D baseline, on the second such PR — the first cold-builds).

## Hand-off

Area D is independent of Area E. After merge, proceed to the final plan: `docs/superpowers/plans/<date>-ci-area-e-act-harness-cleanup.md` (not yet written). Areas D and E can be implemented in parallel by separate worktrees if desired.
