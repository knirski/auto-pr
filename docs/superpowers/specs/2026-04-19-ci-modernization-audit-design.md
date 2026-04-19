# CI Modernisation Audit (Design)

**Date:** 2026-04-19
**Scope:** Areas A, B, D, E, F from the brainstorming session. Area C (committed `dist/`) is explicitly **out of scope** at the user's request.
**Goal:** Identify where the current CI setup reinvents the wheel, duplicates itself, or drifts from standard GitHub Actions idioms. Propose targeted modernisations grouped by theme and area, preserving all existing guarantees (externally-called reusables, branch protection contracts, Nix reproducibility, local-CI capability).

This is a **design / audit document**, not an implementation plan. Each area ends with a pointer to a follow-up plan (one per area).

---

## 1. Principles (cross-cutting conventions)

The audit adopts six conventions. Several are partially followed already; all are normative going forward.

### 1.1 Prefer `./` over `knirski/auto-pr/...@<SHA>` for internal callsites

`uses: ./.github/…` resolves against the workflow's own repository regardless of who triggered the run. Pinned self-refs (`knirski/auto-pr/.github/…@<SHA>`) are **only** required when the containing workflow is executed inside an adopter's repo — namely:

- `auto-pr.yml` (distributed as a template by `auto-pr-init`)
- `auto-pr-generate-reusable.yml` (externally called via `workflow_call`)
- `auto-pr-create-reusable.yml` (externally called via `workflow_call`)

Every other workflow in the repo runs only in `knirski/auto-pr` and should use `./`. Already done in `check.yml:26` (`update-workflow-pins` action). Breach today: `check.yml:43` (`setup-runtime`).

### 1.2 Entry workflows are thin; logic lives in reusables

Entry workflows (`ci*.yml`) carry only the trigger, concurrency, permissions, and a `uses: ./.github/workflows/<reusable>.yml` call. Any `run:` / `uses:` body belongs in the reusable.

### 1.3 A single pass-through `gate` job replaces fan-out pass-throughs

Required-status-check contracts are satisfied by one `gate` job per entry workflow, not by running identical `check` jobs on every path. Standard idiom:

```yaml
gate:
  needs: [check, integration, website, workflows-lint, nix]
  if: always()
  steps:
    - name: Verify required checks
      run: |
        results="${{ toJSON(needs.*.result) }}"
        echo "$results" | jq -e 'all(. == "success" or . == "skipped")'
```

Branch protection requires **`ci / gate`** only. No more per-filter entry workflows whose sole purpose is to report `check / check = success` for unrelated diffs.

### 1.4 Third-party actions: SHA + `# vX.Y.Z` comment, Dependabot-grouped

Already applied (`.github/dependabot.yml`). `bun-minor-patch`, `gh-actions-minor-patch`, `docker` groups. Majors stay ungrouped (human review). No change required; convention formalised here.

### 1.5 Concurrency groups everywhere; `cancel-in-progress: true` by default

Every workflow that can be re-triggered (push, pull_request, schedule, workflow_call) sets:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

Exception: long-running single-commit-scoped workflows (release-please, update-dist, add-dist-to-release-pr) set `cancel-in-progress: false` so in-flight releases are not aborted.

### 1.6 `persist-credentials: false` on `actions/checkout` unless the job must push

Default posture is "checkout without token." Widen only per-job and document why.

---

## 2. Area A — Entry-point fan-out

### 2.1 Current state

Six entry workflows funnel into two reusables (`check.yml`, `integration.yml`) plus three thin reusables (`check-workflows.yml`, `check-website.yml`, `nix.yml`). The fan-out exists to report `check / check` + `check / integration` status on every PR regardless of which paths changed.

| Entry | Trigger path | Calls |
|---|---|---|
| `ci.yml` | anything **except** `**/*.md`, `.github/**`, `website/**` | `check.yml` + `integration.yml` + `dependency-review` |
| `ci-docs.yml` | `**/*.md` | `check.yml` (pass-through) |
| `ci-website.yml` | `website/**` | `check-website.yml` |
| `ci-workflows.yml` | `.github/**` | `check-workflows.yml` |
| `ci-release-please.yml` | `.release-please-manifest.json` | `check.yml` + `integration.yml` |
| `ci-nix.yml` | `**/*.nix`, `package*.json`, `bun.lock`, `flake.lock` | `nix.yml` |

### 2.2 Problems

1. Six entry files duplicate `on:` / `concurrency:` / `permissions:` boilerplate. Any cross-cutting convention change (e.g. principle 1.5) must be repeated six times.
2. `ci-docs.yml` is a pure pass-through. The `check / check` job reports success for docs-only PRs without having actually run `check`. The status name lies about what ran.
3. `ci-release-please.yml` re-runs `check` + `integration` when a single file (`.release-please-manifest.json`) changes. That's a branch-protection workaround masquerading as a distinct CI concern.
4. Contributors debugging "waiting for status to be reported" need the full fan-out matrix in their head.

### 2.3 Decision

**Consolidate to a single `ci.yml`** with:

- `dorny/paths-filter@<SHA>` as the first job, exposing outputs `code`, `docs`, `website`, `workflows`, `nix`, `release_manifest`.
- Downstream jobs (`check`, `integration`, `nix`, `website`, `workflows-lint`) guarded by their filter.
- A final `gate` job (principle 1.3) that `needs: […all…]` and verifies `success` or `skipped`.

Delete: `ci-docs.yml`, `ci-website.yml`, `ci-workflows.yml`, `ci-release-please.yml`, `ci-nix.yml`. Keep `ci.yml`, `check.yml`, `integration.yml`, `check-workflows.yml`, `check-website.yml`, `nix.yml`.

**Trade-off accepted:** add one third-party action dependency (`dorny/paths-filter` — widely adopted, OpenSSF-scored, Dependabot-managed). The wins (five files deleted, gate-job truth-in-naming, single status contract) outweigh the one new pinned SHA.

### 2.4 Branch-protection migration

Required status checks change from `check / check` + `check / integration` → `ci / gate`. Procedure:

1. Merge the consolidated `ci.yml` while keeping the old entry workflows in place temporarily.
2. Wait one green run on main so `ci / gate` appears in branch protection's job list.
3. Add `ci / gate` as a required check in parallel with the old ones.
4. Verify one PR shows both old and new as green.
5. Remove the old required checks; delete the old entry workflows in a follow-up PR.

### 2.5 Follow-up plan

Separate plan: `docs/superpowers/plans/<date>-ci-area-a-consolidate-entry-workflows.md`.

---

## 3. Area B — Self-referential pin automation

### 3.1 Current state

Self-refs and supporting machinery:

| Location | Ref | Context | Load-bearing? |
|---|---|---|---|
| `check.yml:43` | `setup-runtime` | Internal-only reusable | **No — convertible to `./`** |
| `auto-pr.yml:34` | `auto-pr-generate-reusable.yml` | Template copied to adopter repos | Yes |
| `auto-pr.yml:46` | `auto-pr-create-reusable.yml` | Template copied to adopter repos | Yes |
| `auto-pr-generate-reusable.yml:90` | `setup-runtime` | Externally called | Yes |
| `auto-pr-generate-reusable.yml:99` | `auto-pr-set-pkg` | Externally called | Yes |
| `auto-pr-generate-reusable.yml:118` | `resolve-llama-server-tag` | Externally called | Yes |
| `auto-pr-generate-reusable.yml:145` | `llama-server-docker-start` | Externally called | Yes |
| `auto-pr-generate-reusable.yml:154` | `auto-pr-run-command` | Externally called | Yes |
| `auto-pr-generate-reusable.yml:172` | `llama-server-docker-stop` | Externally called | Yes |
| `auto-pr-create-reusable.yml` (equivalent) | Externally called | Yes |

Machinery: `.github/actions/update-workflow-pins/` (action + `update-pins.sh`), `.github/workflows/update-workflow-pins.yml` (post-merge rewriter), `scripts/smoke-update-pins-check-only.sh` (Lefthook), `check.yml:26` (`check_only` CI gate). Loop prevention: `startsWith(head_commit.message, 'chore(workflows): update self-referential pins')`.

### 3.2 Problems

1. **One convertible ref.** `check.yml:43` can drop to `./`. Every other self-ref is load-bearing.
2. **Post-merge bot is non-optional.** Squash/rebase merges produce a merge commit SHA that does not exist until the merge happens; only a post-merge job can pin to it.
3. **Loop-prevention fragility.** A human commit whose message happens to start with the magic prefix would silently skip the update.
4. **Rationale is scattered.** ADR 0004 motivates the automation but does not mark which refs are load-bearing and why; readers periodically rediscover this.

### 3.3 Decision

- **Convert `check.yml:43` to `./.github/actions/setup-runtime`.** Remove the stale "`./` would resolve to caller's repo" comment.
- **Harden loop prevention** in `update-workflow-pins.yml:24-26`: layer `github.actor == 'github-actions[bot]'` on top of the commit-message check. Belt-and-braces; cheap.
- **Document the load-bearing set.** Add a "Why this automation cannot be deleted" subsection to `docs/CI.md §Workflow pin automation` that names the three files (`auto-pr.yml`, `auto-pr-generate-reusable.yml`, `auto-pr-create-reusable.yml`) and the reasoning (template vs. external `workflow_call`).
- **Leave `update-pins.sh` as-is.** No standard tool exists for this niche; the script is already ~30 lines of sed + validation.

Net: one line of YAML converted, one `if:` condition hardened, one docs paragraph added. The automation stays; its minimum viable surface is now clearly labelled.

### 3.4 Follow-up plan

Small enough to ride along in the Area F sweep. Or standalone: `docs/superpowers/plans/<date>-ci-area-b-pin-cleanup.md`.

---

## 4. Area D — Nix / `bun.nix` / flake

### 4.1 Current state

Three workflows plus a reusable:

- **`nix.yml`** (reusable) — two jobs: `bun-nix` (regenerates `bun.nix` via `nix run .#update-bun-nix`, pushes via GitHub App token) and `build` (matrix `nix flake check` on x86_64-linux, aarch64-linux, aarch64-darwin, with `nix-community/cache-nix-action`).
- **`ci-nix.yml`** — entry; calls `nix.yml` on push/PR touching Nix/dep files.
- **`update-bun-nix.yml`** — 22-line `workflow_dispatch` dispatcher; calls `nix.yml`.
- **`update-flake-lock.yml`** — weekly cron; uses `DeterminateSystems/update-flake-lock`; independent Nix+cache setup.

`flake.nix` uses `bun2nix` (nix-community, `tag=2.0.8`). Dev shell includes `act`, `bun`, `statix`, `deadnix`, `typos`, `actionlint`, `lychee`, `shellcheck`, `shfmt`. `checks.nix-lint` runs statix + deadnix. `packages.update-bun-nix` is a `writeShellApplication`. The flake itself is clean and idiomatic.

### 4.2 Problems

1. **`setup-nix-with-cache` is duplicated three times** — `nix.yml` `bun-nix` job (checkout → install-nix → cache-nix), `nix.yml` `build` job (same), `update-flake-lock.yml` (same). Composite-action candidate.
2. **Cache-key prefix inconsistency.** `nix.yml` build job keys on `nix-${{ matrix.system }}-…`; `update-flake-lock.yml` keys on `nix-${{ runner.os }}-…`. Different prefixes prevent cross-hydration.
3. **`nix.yml:88-98` "Trigger check on new commit"** — explicit `gh workflow run ci.yml` after the App-token push. Comment two lines above claims the push itself triggers CI (which is the documented App-token behaviour). Either the step is redundant, or there is a subtle reason (e.g. path-filter interaction) that is not recorded. Needs investigation; remove or comment.
4. **ADR 0006 apparent conflict.** ADR 0006 chose upstream Nix (`cachix/install-nix-action`) over Determinate. `update-flake-lock.yml` uses `DeterminateSystems/update-flake-lock`. Not actually a contradiction — that action is a lockfile utility, not an installer — but the naming collision confuses readers. Docs-only fix.

### 4.3 Decision (this audit)

1. **Keep `update-bun-nix.yml` as a named dispatcher.** A single 22-line file provides a clearly-named "Update bun.nix" entry in the Actions UI, which contributors use to fix stale `bun.nix` on main. Absorbing it into another workflow (`ci-nix.yml` pre-A, or `ci.yml` post-A) saves one file but loses the named-dispatch UX — not a win. The dispatcher stays; the 22 lines are not the problem.
2. **Extract `./.github/actions/setup-nix-with-cache`.** Composite action wrapping checkout + `cachix/install-nix-action` + `nix-community/cache-nix-action`. Replace all three call sites.
3. **Harmonise cache-key shape.** Canonical: `nix-store-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('**/*.nix', '**/bun.lock', '**/flake.lock') }}`. Pick one prefix (`nix-store-`) so `update-flake-lock` and `ci-nix` can cross-hydrate.
4. **Investigate `nix.yml:88-98`.** Either delete the step (add a comment to the PR explaining the App-token push already triggers CI) or keep it with an inline comment citing the path-filter interaction. Decision in the plan, not this audit.
5. **Add a one-paragraph note** to `docs/CI.md` §Nix explaining that `DeterminateSystems/update-flake-lock` is a single-purpose lockfile utility and does not reopen ADR 0006's installer choice.

### 4.4 Follow-up investigation (out of scope for this audit's plan)

**Evaluate replacing `bun2nix` + committed `bun.nix` with `mkBunDerivation` from nixpkgs.** Potentially eliminates `update-bun-nix` entirely, the post-merge push dance, and one artifact from the repo. Requires scoping: does `mkBunDerivation`'s current implementation handle this project's dep shape? What is the migration cost? Track as a standalone research spec, not a sub-task of this audit.

### 4.5 Follow-up plan

`docs/superpowers/plans/<date>-ci-area-d-nix-cleanup.md`.

---

## 5. Area E — `act` local-CI harness

### 5.1 Current state

Approximately 850 lines across:

- `scripts/act-local-ci.ts` (375 lines, imperative shell)
- `src/core/act-local-ci.ts` (333 lines, pure planning — FC/IS-clean, tested via `test/core/act-local-ci.test.ts`)
- `.github/workflows/act-smoke.yml` (106 lines; 2-cell matrix: dry-run + `check-workflows`)
- `scripts/nix-run-if-missing.sh` (34 lines; picks `act` on PATH or `nix run .#act`)
- `scripts/integration-ephemeral-port.sh` (4 lines; random TCP port)

Three invocation paths are supported: `act` binary on PATH, `nix run .#act`, `gh act` (via `gh extension install nektos/gh-act`). Path selection lives in both `scripts/act-local-ci.ts` and `scripts/nix-run-if-missing.sh`.

### 5.2 Problems

1. **Dev-tool FC/IS split costs 300+ lines of ceremony** for a non-production helper. The user has decided (approach 2 in brainstorming) that this cost is not worth paying for this specific tool, even though the pure tests have value.
2. **`integration-ephemeral-port.sh` is 4 lines in its own file.** File-level indirection for one line of Python.
3. **Three invocation paths** duplicate selection logic in two places.
4. **`actions/cache` version drift.** `act-smoke.yml:81, 99` pin `v4.2.3`; rest of the repo uses `v5.0.4`.

### 5.3 Decision

1. **Collapse the FC/IS split for `act-local-ci` only.** Move all exported pure functions (`planActRun`, `resolveActLocalCiRunnerFromProcessEnv`, `resolveActArtifactServerOpts`, etc.) from `src/core/act-local-ci.ts` into `scripts/act-local-ci.ts` as exported functions. Delete `src/core/act-local-ci.ts`. Update `test/core/act-local-ci.test.ts` → `test/scripts/act-local-ci.test.ts` (or equivalent) with the new import path. **Pure functions stay pure; only the file split goes away.** Tests and their coverage are preserved. This is a scoped exception to the project's FC/IS invariant, documented in AGENTS.md's "Where to Put X" table as a follow-up.
2. **Inline `scripts/integration-ephemeral-port.sh` into its caller.** If called from TS, move to a pure function in the (now-consolidated) `scripts/act-local-ci.ts`. Delete the `.sh` file.
3. **Investigate and likely delete `scripts/nix-run-if-missing.sh`.** Grep for callers; if only `act-local-ci.ts` and `act-smoke.yml`, prefer `gh act` as the canonical entry point (adopters install `gh` anyway for PR creation). Keep plain `act` on PATH as a secondary path only; drop the Nix-run shim. Document in `docs/CI.md` that `gh act` is the canonical entry. If the investigation reveals load-bearing callers, keep the file and add an explanatory comment.
4. **Harmonise `actions/cache` to v5.0.4** in `act-smoke.yml:81, 99`.

### 5.4 Explicit non-goals

- Do not restructure `act-local-ci.ts` further. The flag-planning complexity is inherent to `act`, not self-inflicted.
- Do not remove `act-smoke.yml`. The matrix shape (dry-run + real run) is correct.

### 5.5 Follow-up plan

`docs/superpowers/plans/<date>-ci-area-e-act-harness-cleanup.md`.

---

## 6. Area F — General hygiene (cross-cutting sweep)

### 6.1 Current state

Collection of drift across the 27 workflows, surfaced while auditing A–E.

### 6.2 Checklist

Each item applies across all workflows unless otherwise noted.

1. **Concurrency groups.** Every workflow with `push`, `pull_request`, `schedule`, or `workflow_call` carries `concurrency:` with `cancel-in-progress: true`. Exceptions: `release-please.yml`, `update-dist.yml`, `add-dist-to-release-pr.yml` use `cancel-in-progress: false` (release workflows must complete).
2. **`persist-credentials: false`** on every `actions/checkout` step that does not explicitly push. Jobs that do push (pin updater, bun-nix updater, release-please bot) use the App token explicitly and keep credentials off disk otherwise.
3. **`timeout-minutes:`** on every job. Pick per job:
   - Fast lints / pass-through jobs: **5–10 minutes**.
   - `check.yml`, `nix.yml/build`: **20 minutes** (current).
   - Heavy jobs (integration, auto-pr-generate-reusable): **25 minutes** (current).
   - Release / dist: **10 minutes** (quick git ops).
   - **No workflow relies on the default 360-minute timeout.**
4. **`actions/cache` harmonised to v5.0.4** across every workflow (`act-smoke.yml:81, 99` is the known breach; full grep sweep required).
5. **Workflow `name:` uniqueness.** `ci.yml` and `ci-nix.yml` both use `name: CI`. Rename `ci-nix.yml` → `name: CI (Nix)` so the Actions tab is readable. (After Area A consolidation, `ci-nix.yml` may not exist anymore; if so, this item no-ops.)
6. **Runner images explicit.** Replace any `runs-on: ubuntu-latest` with `runs-on: ubuntu-24.04` (or `ubuntu-24.04-arm`). OpenSSF best practice.
7. **Top-level `permissions: {}`** on every workflow; widen per-job only. Sweep for top-level widenings and push them down.
8. **Composite-action third-party pins.** Sweep `.github/actions/**/action.yml`; every `uses:` for a third-party action is `@<SHA> # vX.Y.Z`. Dependabot-grouped same as workflow YAML.

### 6.3 Decision

Treat as a single focused PR with the eight checklist items as sub-tasks. No alternatives considered — the sweep applies conventions uniformly.

### 6.4 Follow-up plan

`docs/superpowers/plans/<date>-ci-area-f-hygiene-sweep.md`.

---

## 7. Out of scope / explicit non-goals

- **Area C (committed `dist/` + `update-dist.yml` + `add-dist-to-release-pr.yml`).** User preserved this deliberately. Not audited.
- **Publish-to-npm migration.** Would obsolete Area C entirely. Not this spec's concern.
- **Replacing `bun2nix` with `mkBunDerivation`.** Listed as a follow-up investigation under Area D; needs its own spec cycle.
- **OpenSSF Scorecard follow-ups.** Out of scope; `2026-04-02-openssf-scorecard-improvements-design.md` handles those.
- **Restructuring `scripts/act-local-ci.ts` beyond the FC/IS collapse.** The tool's inherent complexity is not audited here.

---

## 8. Ordering and sequencing

Follow-up plans can be implemented independently but a natural ordering exists:

1. **F (hygiene sweep)** — unblocks correct conventions across whatever else gets edited. Lowest risk.
2. **B (pin cleanup)** — one-line code change + doc; trivial.
3. **A (entry consolidation)** — requires branch-protection migration. Must be sequenced carefully; Area A §2.4 documents the procedure.
4. **D (Nix cleanup)** — independent of A/B/F.
5. **E (act harness)** — independent; mostly local to `scripts/` and one workflow.

Each plan is independently mergeable. A, in particular, should ship on its own so branch-protection migration has a clean diff.

---

## 9. Success criteria

An implementation is complete when:

- **A:** Branch protection requires `ci / gate` only; five entry workflows deleted; `dorny/paths-filter` in Dependabot; no hosted CI regressions for a week.
- **B:** `check.yml:43` uses `./`; `update-workflow-pins.yml` `if:` checks actor; `docs/CI.md` names the load-bearing files.
- **D:** `setup-nix-with-cache` composite in use at all three call sites; cache-key prefix unified to `nix-store-…`; `nix.yml:88-98` either deleted or commented; `docs/CI.md` disambiguates ADR 0006; `update-bun-nix.yml` retained as named dispatcher.
- **E:** `src/core/act-local-ci.ts` deleted with tests relocated and passing; `scripts/integration-ephemeral-port.sh` deleted; `scripts/nix-run-if-missing.sh` deleted or annotated; `actions/cache@v5` throughout `act-smoke.yml`.
- **F:** All eight checklist items applied uniformly across the repo; CI continues green.

No workflow regresses in wall-time (target: each area is neutral-or-faster on `check.yml` wall-time compared to pre-change baseline). Area A is expected to be neutral; Areas D/E/F are expected to be neutral. No perf target is binding — correctness and simplicity first.

---

## 10. Chosen implementation order (plans)

Section 8 defines the recommended merge sequence. **The first plan to execute is Area F** — it establishes conventions everywhere so Areas B, A, D, and E inherit a consistent baseline.

| Order | Area | Plan file |
|------:|------|-----------|
| 1 | **F** — General hygiene | [`docs/superpowers/plans/2026-04-19-ci-area-f-hygiene-sweep.md`](../plans/2026-04-19-ci-area-f-hygiene-sweep.md) |
| 2 | **B** — Pin cleanup | [`docs/superpowers/plans/2026-04-19-ci-area-b-pin-cleanup.md`](../plans/2026-04-19-ci-area-b-pin-cleanup.md) |
| 3 | **A** — Entry consolidation | [`docs/superpowers/plans/2026-04-19-ci-area-a-consolidate-entry-workflows.md`](../plans/2026-04-19-ci-area-a-consolidate-entry-workflows.md) |
| 4 | **D** — Nix cleanup | [`docs/superpowers/plans/2026-04-19-ci-area-d-nix-cleanup.md`](../plans/2026-04-19-ci-area-d-nix-cleanup.md) |
| 5 | **E** — Act harness | [`docs/superpowers/plans/2026-04-19-ci-area-e-act-harness-cleanup.md`](../plans/2026-04-19-ci-area-e-act-harness-cleanup.md) |

**Start here:** open and follow the Area F plan first; after it merges to `main` with green CI, proceed to B, then A (with branch-protection steps as in Area A’s plan), then D and E in either order if parallel capacity allows.
