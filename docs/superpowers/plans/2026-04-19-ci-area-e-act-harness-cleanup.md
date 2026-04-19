# CI Area E — `act` Harness Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `act` local-CI harness surface area by (a) collapsing the FC/IS file split for this dev tool only, (b) inlining `scripts/integration-ephemeral-port.sh` into its YAML callers, and (c) annotating `scripts/nix-run-if-missing.sh` to record its load-bearing role (rather than deleting it — investigation reveals many non-act callers).

**Architecture:**
- `src/core/act-local-ci.ts` (333 lines of pure functions) is moved WHOLESALE into `scripts/act-local-ci.ts`. Pure functions stay pure; only the file split goes away.
- The two test files (`test/core/act-local-ci.test.ts` — 21 tests, and `test/scripts/act-local-ci.test.ts` — 5 tests) are merged into one at `test/scripts/act-local-ci.test.ts`.
- `scripts/integration-ephemeral-port.sh` is replaced by a `python3 -c` one-liner inlined at its two call sites in `integration.yml`.
- `scripts/nix-run-if-missing.sh` stays — investigation shows 7+ callers beyond act (check:nix, check:docs, check:just-links, lint:scripts, format:scripts, lint:workflows, lefthook); it's general-purpose tool-fallback infrastructure, not act-specific. Annotate with a header comment listing callers.
- `AGENTS.md`'s "Where to Put X" table gains a row documenting the FC/IS exception.

**Tech Stack:** TypeScript (Bun test), Effect v4 (`Option`, `Predicate`, `Result`), GitHub Actions YAML, bash.

**Reference spec:** `docs/superpowers/specs/2026-04-19-ci-modernization-audit-design.md` §5 (Area E).

**Branch:** `ai/ci-area-e-act-harness-cleanup` (per project convention: `ai/` prefix).

**Dependency ordering:** Per spec §8, Area E lands fifth (last). Areas F, B, A, D have merged. In particular: Area F already harmonised `actions/cache` to v5.0.4 in `act-smoke.yml` (spec §5.3.4 item), so that sub-item of Area E is already done — this plan verifies and proceeds.

**Out of scope (spec §5.4):**
- Restructuring `scripts/act-local-ci.ts` further (the inherent `act` flag-planning complexity stays).
- Removing `act-smoke.yml`.
- Changing `ActLocalCiError` or other `#core/errors.js` content.

---

## Background: what the investigation changed

Two of the three file-surface items shift vs. the spec once the code is actually inspected:

1. **`nix-run-if-missing.sh` stays.** The spec's §5.3.3 decision includes a conditional: "If the investigation reveals load-bearing callers, keep the file and add an explanatory comment." Grep reveals callers in:
   - `package.json`: `check:nix`, `check:docs`, `check:just-links`, `lint:scripts`, `format:scripts`, `lint:workflows`, lefthook hook
   - `src/core/act-local-ci.ts` / `scripts/act-local-ci.ts` (the shim they reference in planActRun)
   - `test/core/act-local-ci.test.ts` / `test/scripts/act-local-ci.test.ts` (assertions about the command shape)
   - `knip.json` (ignoreBinaries)

   The spec's optimistic case ("only act-local-ci.ts and act-smoke.yml use it") doesn't hold. Keep + annotate.

2. **`src/core/index.ts` re-exports 23 act-local-ci symbols.** These re-exports are consumed by nothing outside the act harness itself (`src/auto-pr/index.ts` imports other core barrels, not act-local-ci). When we delete `src/core/act-local-ci.ts`, those barrel re-exports go too.

3. **The `actions/cache@v5.0.4` harmonisation is already done** by Area F. This plan's Task 1 verifies and moves on.

---

## File Inventory

| Task | Files touched |
|---|---|
| 1 (verify Area F) | none (grep only) |
| 2 (collapse FC/IS) | `scripts/act-local-ci.ts` (absorbs pure functions), `src/core/act-local-ci.ts` (deleted), `src/core/index.ts` (remove act-local-ci re-exports) |
| 3 (merge tests) | `test/scripts/act-local-ci.test.ts` (absorbs), `test/core/act-local-ci.test.ts` (deleted) |
| 4 (local test run) | none |
| 5 (inline ephemeral-port) | `.github/workflows/integration.yml` (two call sites), `scripts/integration-ephemeral-port.sh` (deleted), `docs/INTEGRATION.md`, `docs/CI.md` (prose updates) |
| 6 (annotate nix-run-if-missing) | `scripts/nix-run-if-missing.sh` (header comment only) |
| 7 (document FC/IS exception) | `AGENTS.md` |
| 8 (doc sweep) | `docs/ARCHITECTURE.md`, `docs/CI.md`, any other references |
| 9 (verify + PR) | none |

---

## Task 0: Branch Setup

**Files:** none.

- [ ] **Step 1: Fresh branch from `main`**

```bash
git checkout main
git pull --ff-only
git checkout -b ai/ci-area-e-act-harness-cleanup
```

- [ ] **Step 2: Confirm prior areas landed**

```bash
git log --oneline --grep='Area F\|Area B\|Area A Phase 2\|Area D' main -15
```

Expected: commits from F, B, A (both phases), D visible.

- [ ] **Step 3: Clean tree**

Run: `git status`
Expected: `nothing to commit, working tree clean`

---

## Task 1: Verify `actions/cache` in `act-smoke.yml` is already at v5.0.4

**Purpose:** Spec §5.3.4 lists cache harmonisation as part of Area E, but Area F already addressed it. Confirm before moving on.

**Files:** none.

- [ ] **Step 1: Grep**

Run:
```bash
grep -n "actions/cache@" .github/workflows/act-smoke.yml
```

Expected: every occurrence is `actions/cache@668228422ae6a00e4ad889ee87cd7109ec5666a7 # v5.0.4`. If any line still shows `# v4.2.3`, this sub-item was missed — fix it here and note in the commit message. Otherwise no work needed.

If a fix IS needed:

Replace both remaining occurrences:

From:
```yaml
uses: actions/cache@5a3ec84eff668545956fd18022155c47e93e2684 # v4.2.3
```

To:
```yaml
uses: actions/cache@668228422ae6a00e4ad889ee87cd7109ec5666a7 # v5.0.4
```

Commit:
```bash
git add .github/workflows/act-smoke.yml
git commit -m "ci(act-smoke): complete Area F's actions/cache v5 harmonisation"
```

Otherwise: no commit; proceed to Task 2.

---

## Task 2: Collapse the FC/IS split — merge `src/core/act-local-ci.ts` into `scripts/act-local-ci.ts`

**Purpose:** This is a scoped exception to the project's FC/IS invariant, applied ONLY to the `act-local-ci` dev tool. Pure functions stay pure (their signatures and semantics are unchanged); only the file-level separation goes away.

**Why this exception:** per spec §5.2.1, "Dev-tool FC/IS split costs 300+ lines of ceremony for a non-production helper." The split is valuable for production code where unit tests isolate logic from I/O; for a dev-only entrypoint like act-local-ci, the ceremony isn't justified.

**The test coverage is preserved.** All 21 tests currently in `test/core/act-local-ci.test.ts` move to `test/scripts/act-local-ci.test.ts` in Task 3, with imports updated but assertions unchanged.

**Files:**
- Modify: `scripts/act-local-ci.ts` (absorbs ~333 lines of pure functions)
- Delete: `src/core/act-local-ci.ts`
- Modify: `src/core/index.ts` (remove 23 act-local-ci re-exports)

---

- [ ] **Step 1: Read both files fully**

Read `src/core/act-local-ci.ts` and `scripts/act-local-ci.ts` completely. Note:
- `src/core/act-local-ci.ts` imports: `{ Option, Predicate, Result } from "effect"`, `{ ActLocalCiError } from "#core/errors.js"`.
- `scripts/act-local-ci.ts` imports: `{ Effect, FileSystem, Match, Option, Path } from "effect"`, `{ ActLocalCiError } from "#core/errors.js"`, + 14 symbols from `#core/act-local-ci.js` at lines ~20–35, + other runtime modules.

After the merge, `scripts/act-local-ci.ts` needs `Predicate` and `Result` added to its `effect` import, and the `#core/act-local-ci.js` import block deleted.

- [ ] **Step 2: Append the pure-function block to `scripts/act-local-ci.ts`**

Copy the ENTIRE body of `src/core/act-local-ci.ts` (lines 5–333, everything below the file-level docstring) and paste it into `scripts/act-local-ci.ts`. Placement: **immediately after the imports block and before the existing impure code** (typically right after the opening imports, above the `INSTALL_HINTS` constant or equivalent).

Placement rationale: keeping the pure section visually at the top of the file preserves the "pure helpers first, then impure orchestration" reading order that the old FC/IS split provided.

Edits:
- Do NOT re-import anything from `#core/act-local-ci.js` inside the copied block — the copied code defines those symbols locally now.
- Do NOT duplicate the `import { ActLocalCiError } from "#core/errors.js"` line (already present in `scripts/act-local-ci.ts`).
- Do NOT duplicate `Option` import (already there); just ensure `Predicate` and `Result` are added.

- [ ] **Step 3: Update the effect import**

In `scripts/act-local-ci.ts`'s top-of-file imports, change:

From:
```ts
import { Effect, FileSystem, Match, Option, Path } from "effect";
```

To:
```ts
import { Effect, FileSystem, Match, Option, Path, Predicate, Result } from "effect";
```

(Alphabetically sorted per Effect's convention.)

- [ ] **Step 4: Delete the now-stale `#core/act-local-ci.js` import block**

In `scripts/act-local-ci.ts`, delete the multi-line import (lines ~20–35) that currently imports 14 symbols from `#core/act-local-ci.js`. Those symbols are now defined inline in this file.

Verify no dangling `#core/act-local-ci` references remain in this file:

```bash
grep -n "#core/act-local-ci" scripts/act-local-ci.ts
```

Expected: no matches.

- [ ] **Step 5: Update the file-level docstring comment**

The current docstring at the top of `scripts/act-local-ci.ts` likely reads:

```ts
/**
 * Effect CLI (`effect/unstable/cli`) + `ChildProcess` for inherit stdio; pure helpers in #core/act-local-ci.
 * ...
 */
```

Update the phrase "pure helpers in #core/act-local-ci" → "pure helpers inline above." If there's a doc comment above `planActRun` that references `scripts/nix-run-if-missing.sh`, leave it — that's unrelated.

- [ ] **Step 6: Remove act-local-ci re-exports from `src/core/index.ts`**

In `src/core/index.ts`, delete the two blocks that re-export from `#core/act-local-ci.js`:

```ts
export type {
  ActBackend,
  ActLocalCiMode,
  ActLocalCiRun,
  ActRunPlan,
  ActWorkflowDispatchGitPointer,
  ActWorkflowDispatchRepo,
  BuildActArgsInput,
  ResolveActRunnerImageArgs,
} from "#core/act-local-ci.js";
export {
  ACT_GENERATED_EVENT_RELATIVE_PATH,
  ACT_LOCAL_CI_MODES,
  buildActArgv,
  CI_EVENT,
  CI_WORKFLOW,
  CI_WORKFLOWS_ENTRY,
  DEFAULT_ACT_RUNS_ON_LABEL,
  INTEGRATION_WORKFLOW,
  isActLocalCiMode,
  parseGithubRepoFromPackageJsonRepository,
  parseGithubRepoFromRemoteUrl,
  parseGithubRepoFromShortName,
  planActRun,
  resolveActArtifactServerOpts,
  resolveActLocalCiInput,
  resolveActLocalCiRunnerFromProcessEnv,
  resolveActRunnerImage,
  resolveActWorkflowDispatchRepo,
  stringifyWorkflowDispatchEventJson,
} from "#core/act-local-ci.js";
```

Delete both blocks entirely. The remaining re-exports from `collapse-prose-paragraphs`, `errors`, `fill-pr-template-core`, `gh-output`, etc. stay.

- [ ] **Step 7: Delete `src/core/act-local-ci.ts`**

```bash
git rm src/core/act-local-ci.ts
```

- [ ] **Step 8: Typecheck**

Run: `bun run typecheck` (or the project's equivalent — check `package.json` scripts).

Expected: zero errors. If type errors surface:
- In `src/auto-pr/index.ts` or elsewhere: a re-export was actually consumed — restore it in `src/core/index.ts` by re-exporting from the new location (`scripts/act-local-ci.ts`). But this requires a relative path from src/ to scripts/, which is a layering violation — a simpler fix is to import the consumer directly from `scripts/act-local-ci.ts`. Investigate case by case.
- In `scripts/act-local-ci.ts`: likely a missed import or a symbol-use mismatch from the copy-paste. Fix locally.

Do NOT proceed to Task 3 until typecheck is clean.

- [ ] **Step 9: Commit**

```bash
git add scripts/act-local-ci.ts src/core/act-local-ci.ts src/core/index.ts
git commit -m "refactor(act-local-ci): collapse FC/IS split into single script file (scoped exception)"
```

---

## Task 3: Merge test files — `test/core/act-local-ci.test.ts` → `test/scripts/act-local-ci.test.ts`

**Purpose:** After Task 2, `src/core/act-local-ci.ts` no longer exists. The 21 tests in `test/core/act-local-ci.test.ts` testing pure functions need a new home. The existing `test/scripts/act-local-ci.test.ts` (5 tests for impure behavior) is the natural destination.

**Files:**
- Modify: `test/scripts/act-local-ci.test.ts` (absorbs 21 more tests; updates imports)
- Delete: `test/core/act-local-ci.test.ts`

---

- [ ] **Step 1: Read both test files**

Read `test/core/act-local-ci.test.ts` (284 lines, 21 tests) and `test/scripts/act-local-ci.test.ts` (155 lines, 5 tests). Note:
- Both currently import from `#core/act-local-ci.js` — after Task 2 that module is gone.
- Both files should now import from the new home: either directly from `scripts/act-local-ci.ts` (relative path `../../scripts/act-local-ci`) or via a path alias if one exists for scripts/.

Check for a scripts/ path alias:
```bash
grep -n "#scripts\|paths.*scripts" tsconfig.json package.json 2>/dev/null
```

- If an alias like `#scripts/*` exists → use `#scripts/act-local-ci.js` in imports.
- If not → use the relative path `../../scripts/act-local-ci`. The relative path works but is less clean; consider adding a `#scripts/*` alias in `tsconfig.json` + `package.json`'s `imports` field. That's an optional polish — the plan includes it as Step 4 below.

- [ ] **Step 2: Merge tests into `test/scripts/act-local-ci.test.ts`**

Copy the bodies of all 21 `describe`/`test` blocks from `test/core/act-local-ci.test.ts` into `test/scripts/act-local-ci.test.ts`. Place them AFTER the existing 5 tests, grouped under their own top-level `describe("pure helpers", …)` block if they weren't already wrapped:

```ts
describe("pure helpers", () => {
  // 21 tests pasted here
});
```

(If the original `test/core/act-local-ci.test.ts` already had a single top-level `describe("act-local-ci", …)` wrapping everything, rename it to `describe("pure helpers", …)` to avoid name collision with the impure suite.)

- [ ] **Step 3: Update imports in the merged file**

Unified imports at the top of `test/scripts/act-local-ci.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Option, Result } from "effect"; // or whatever the original tests imported
import {
  /* union of all symbols the merged file needs — pure helpers AND existing 5 tests' targets */
} from "#scripts/act-local-ci.js"; // or "../../scripts/act-local-ci" if no alias
```

Ensure the import list covers: every symbol used by any of the 26 tests now in the file. De-duplicate.

- [ ] **Step 4 (optional — recommended): Add a `#scripts/*` path alias**

If no alias exists: add one to make imports clean.

`tsconfig.json` (within `compilerOptions.paths`):
```jsonc
{
  "compilerOptions": {
    "paths": {
      "#auto-pr/*": ["./src/auto-pr/*"],
      "#core/*": ["./src/core/*"],
      "#scripts/*": ["./scripts/*"]  // new
    }
  }
}
```

`package.json` (within top-level `imports`):
```json
{
  "imports": {
    "#scripts/*": "./scripts/*"
  }
}
```

Then use `#scripts/act-local-ci.js` in the test file's import. If you skip this step, use the relative path `../../scripts/act-local-ci` instead — both work.

- [ ] **Step 5: Delete the old test file**

```bash
git rm test/core/act-local-ci.test.ts
```

- [ ] **Step 6: Run the test suite**

Run: `bun test test/scripts/act-local-ci.test.ts`
Expected: 26 tests pass (21 pure + 5 impure).

If any test fails:
- Import path issue: adjust the import syntax.
- Symbol missing: verify Task 2 successfully copied all exports.

Run the FULL test suite:
```bash
bun test
```

Expected: all tests pass, coverage unchanged (the pure functions have the same test coverage as before, just in a different file).

- [ ] **Step 7: Commit**

```bash
git add test/
git commit -m "test(act-local-ci): merge pure-helper tests into scripts test file"
```

---

## Task 4: Build verification

**Purpose:** The project bundles via `scripts/build.ts` and `bun build`. Confirm the build still works post-collapse (scripts/ isn't bundled but any references to `src/core/act-local-ci.ts` are gone).

**Files:** none.

- [ ] **Step 1: Run the build**

```bash
bun run build
```

Expected: completes without error.

- [ ] **Step 2: Typecheck one more time**

```bash
bun run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Full check**

```bash
bun run check:code
```

Expected: exits 0.

No commit in this task.

---

## Task 5: Inline `scripts/integration-ephemeral-port.sh` into its YAML callers

**Purpose:** The 4-line script (`python3 -c 'import socket...'` one-liner) is called only from `.github/workflows/integration.yml` (two steps). The spec flags this as "File-level indirection for one line of Python." Inline it.

**The script's actual content:**

```bash
#!/usr/bin/env bash
# Print one free TCP port (kernel-assigned via bind to :0).
set -euo pipefail
python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
```

The meaningful line is the `python3 -c '...'`. Everything else is shell boilerplate that YAML's `run:` block already provides (bash, `set -euo pipefail` is common).

**Files:**
- Modify: `.github/workflows/integration.yml` (two call sites at lines ~32 and ~140)
- Delete: `scripts/integration-ephemeral-port.sh`
- Update: `docs/CI.md`, `docs/INTEGRATION.md` references

---

- [ ] **Step 1: Read `integration.yml`'s two call sites**

Current form at both sites (line ~32 and ~140):

```yaml
      # Ephemeral port on this runner (`scripts/integration-ephemeral-port.sh`: python3 bind :0 — ships on Ubuntu runners).
      - name: Llama port and OpenAI base URL (stub job)
        run: |
          port="$(bash "$GITHUB_WORKSPACE/scripts/integration-ephemeral-port.sh")"
          echo "INTEGRATION_LLAMA_PORT=$port" >> "$GITHUB_ENV"
          echo "AUTO_PR_AI_OPENAI_COMPAT_URL=http://127.0.0.1:${port}/v1" >> "$GITHUB_ENV"
```

- [ ] **Step 2: Replace both call sites**

At BOTH call sites, change the comment and the `port=...` line:

From:
```yaml
      # Ephemeral port on this runner (`scripts/integration-ephemeral-port.sh`: python3 bind :0 — ships on Ubuntu runners).
      - name: Llama port and OpenAI base URL (stub job)
        run: |
          port="$(bash "$GITHUB_WORKSPACE/scripts/integration-ephemeral-port.sh")"
```

To:
```yaml
      # Kernel-assigned ephemeral port (python3 socket bind — python3 ships on Ubuntu runners).
      - name: Llama port and OpenAI base URL (stub job)
        run: |
          port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
```

Preserve the second job's step name if it differs (e.g. "(high capability)" vs "(stub)").

- [ ] **Step 3: Delete the script**

```bash
git rm scripts/integration-ephemeral-port.sh
```

- [ ] **Step 4: Update doc references**

`docs/CI.md:111` and `docs/INTEGRATION.md:228` both mention the script by name. Update both to describe the inline form. Minimal edits:

In `docs/CI.md:111`, change:
- From: "`scripts/integration-ephemeral-port.sh` via **`python3`**"
- To: "an inline **`python3`** one-liner in `integration.yml`"

In `docs/INTEGRATION.md:228`, change:
- From: "`scripts/integration-ephemeral-port.sh` (**`python3`**: `bind(127.0.0.1, 0)` — Python is preinstalled on GitHub-hosted Ubuntu; not inside nested containers)"
- To: "an inline **`python3`** one-liner in [integration.yml](../../../.github/workflows/integration.yml) (`bind(127.0.0.1, 0)` — Python is preinstalled on GitHub-hosted Ubuntu; not inside nested containers)"

Exact wording can vary; preserve the technical details (localhost, port 0, Python preinstalled on Ubuntu).

- [ ] **Step 5: Verify no remaining references**

```bash
grep -rn "integration-ephemeral-port" . --include='*.yml' --include='*.ts' --include='*.sh' --include='*.md' --include='*.json' 2>/dev/null | grep -v '.worktrees\|node_modules'
```

Expected: no matches.

- [ ] **Step 6: Lint workflows**

Run: `bun run lint:workflows`
Expected: exits 0. `shellcheck` may or may not lint the inline `run:` block — either way, the python one-liner is syntactically trivial.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "ci(integration): inline ephemeral-port python one-liner; delete separate script"
```

---

## Task 6: Annotate `scripts/nix-run-if-missing.sh` with its load-bearing status

**Purpose:** Spec §5.3.3 proposed deleting this script as redundant with `gh act`. Investigation reveals ~10 load-bearing callers across `package.json` scripts, lefthook, tests, and knip — unrelated to act. Following the spec's conditional ("If the investigation reveals load-bearing callers, keep the file and add an explanatory comment"), we annotate.

**Files:** `scripts/nix-run-if-missing.sh` (add header comment).

---

- [ ] **Step 1: Read the current header**

Read `scripts/nix-run-if-missing.sh` (34 lines). It likely has a brief usage comment at the top. Preserve it.

- [ ] **Step 2: Prepend a load-bearing-callers comment**

Insert a comment block immediately after the `#!/usr/bin/env bash` shebang, before the existing `# Usage:` comment:

```bash
#!/usr/bin/env bash
#
# Load-bearing: do NOT delete. Used broadly as a "run via PATH or fall back to `nix run`" helper:
#   - package.json scripts: check:nix, check:docs, check:just-links, lint:scripts,
#     format:scripts, lint:workflows
#   - lefthook pre-commit (shfmt -w on staged scripts)
#   - scripts/act-local-ci.ts (planActRun's `direct` backend resolves act via this shim)
#   - knip.json ignoreBinaries (prevents false-positive unused)
#
# The 2026-04-19 CI modernisation audit (Area E, spec §5) considered deleting this
# in favor of `gh act`, but investigation revealed the act-harness use is only one
# of many. This shim is general-purpose tool-fallback infrastructure — keep it.
#
# Usage: nix-run-if-missing.sh [--optional] <tool> [args...]
# ...existing usage comment follows...
```

Preserve the existing `# Usage:` block below this new header.

- [ ] **Step 3: Verify shellcheck / shfmt still accept the file**

Run:
```bash
bash scripts/nix-run-if-missing.sh --help 2>/dev/null || true  # confirms it still parses
bun run lint:scripts
```

Expected: `lint:scripts` exits 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/nix-run-if-missing.sh
git commit -m "scripts(nix-run-if-missing): document load-bearing callers (keep per spec §5 conditional)"
```

---

## Task 7: Document the FC/IS exception in `AGENTS.md`

**Purpose:** Task 2 introduced a scoped deviation from the project's FC/IS convention. Record it in the AGENTS.md "Where to Put X" table so future contributors (and agents) don't recreate the split by mistake.

**Files:** `AGENTS.md`

---

- [ ] **Step 1: Locate the "Where to Put X" table**

Read `AGENTS.md` near line 52. The table has rows like:
- "Pure validation, helpers | `src/core/*.ts` (fill-pr-template-core, string, gh-output, etc.)"
- "New tagged error class | `src/core/errors.ts`; add `formatError` branch in `src/auto-pr/errors.ts`"

- [ ] **Step 2: Add a row for the act-local-ci exception**

Insert immediately after the "Pure validation, helpers" row:

```markdown
| Dev-tool pure helpers (act-local-ci ONLY) | `scripts/act-local-ci.ts` (alongside the imperative parts — scoped FC/IS exception, see [`2026-04-19-ci-modernization-audit-design.md` §5](docs/superpowers/specs/2026-04-19-ci-modernization-audit-design.md)). Do NOT extend this exception to other code. |
```

Adjust the table formatting (column widths) to match neighbouring rows.

- [ ] **Step 3: Review the surrounding "Architecture" / "FC/IS" bullets**

Near line 113, `AGENTS.md` has a line:
```
- **FC/IS:** Core pure (no Effect, no I/O, returns `Result`). Shell orchestrates I/O, bridges with `Effect.fromResult`.
```

Add a footnote or parenthetical noting the exception. Simplest form — append to the existing bullet:

```
- **FC/IS:** Core pure (no Effect, no I/O, returns `Result`). Shell orchestrates I/O, bridges with `Effect.fromResult`. (Single known exception: `scripts/act-local-ci.ts` dev tool; see "Where to Put X" table.)
```

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs(agents): record act-local-ci FC/IS exception in 'Where to Put X' table"
```

---

## Task 8: Documentation sweep

**Purpose:** Other docs reference the pre-Area-E file layout. Update references to match reality.

**Files:** `docs/ARCHITECTURE.md`, `docs/CI.md` (if not already updated), any other `.md` with stale references.

---

- [ ] **Step 1: Find stale references**

```bash
grep -rn "src/core/act-local-ci" docs/ README.md CONTRIBUTING.md 2>/dev/null
```

Expected: at least one match in `docs/ARCHITECTURE.md:83` (the "ActBackend" row references `src/core/act-local-ci.ts`).

- [ ] **Step 2: Update each reference**

For each match, update the file path:
- `src/core/act-local-ci.ts` → `scripts/act-local-ci.ts`.

Specifically in `docs/ARCHITECTURE.md:83`, change:
- From: "See `ActBackend` and `planActRun` in `src/core/act-local-ci.ts`."
- To: "See `ActBackend` and `planActRun` in `scripts/act-local-ci.ts`."

- [ ] **Step 3: Verify links still resolve**

```bash
for f in $(grep -rn "act-local-ci" docs/ --include='*.md' 2>/dev/null | sed -n 's/.*(\([^)]*act-local-ci[^)]*\)).*/\1/p' | sort -u); do
  resolved=$(realpath --relative-to=. "docs/$f" 2>/dev/null || echo "$f")
  test -f "$resolved" && echo "OK: $resolved" || echo "BROKEN: $f ($resolved)"
done
```

(If the sed is finicky, spot-check manually.)

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs: update act-local-ci paths after FC/IS collapse"
```

---

## Task 9: Final Verification and PR

**Files:** none.

---

- [ ] **Step 1: Full test run**

Run: `bun test`
Expected: all tests pass. The test count should be the same as before Area E (same 26 act tests, just consolidated) plus whatever else the project has.

- [ ] **Step 2: Full check**

Run: `bun run check:code && bun run lint:workflows && bun run lint:scripts`
Expected: all exit 0.

- [ ] **Step 3: Dry-run act-smoke workflow locally**

```bash
bun run act-local-ci -- --dry-run check
```

Expected: `act` parses the workflows, prints the check job plan. No errors about missing modules or references.

- [ ] **Step 4: Inventory the diff**

```bash
git log --oneline main..HEAD
git diff main...HEAD --stat
```

Expected: ~7–8 commits, each scoped to one logical concern.

- [ ] **Step 5: Push and open PR**

```bash
git push -u origin ai/ci-area-e-act-harness-cleanup

gh pr create --title "ci: Area E — act harness cleanup (FC/IS collapse, inline port script, annotate nix shim)" --body "$(cat <<'EOF'
## Summary

Implements Area E from the CI modernisation audit (`docs/superpowers/specs/2026-04-19-ci-modernization-audit-design.md` §5).

- **FC/IS collapse (scoped to act-local-ci):** `src/core/act-local-ci.ts` (333 lines) moved wholesale into `scripts/act-local-ci.ts`. Pure functions stay pure; only the file split goes away. All 21 pure-helper tests preserved and merged into `test/scripts/act-local-ci.test.ts`.
- **Inline ephemeral-port script:** the 4-line `scripts/integration-ephemeral-port.sh` replaced by a `python3 -c` one-liner at its two call sites in `integration.yml`. Script file deleted.
- **Annotate, don't delete, `nix-run-if-missing.sh`:** investigation (per spec §5.3.3's conditional) revealed ~10 load-bearing callers beyond act (check:nix, check:docs, check:just-links, lint:scripts, format:scripts, lint:workflows, lefthook, tests, knip). The shim is general-purpose tool-fallback infrastructure. Header comment added listing callers so the next audit doesn't revisit.
- **Documented FC/IS exception** in `AGENTS.md`'s "Where to Put X" table so the act-local-ci exception is explicit and scoped — not a license to collapse elsewhere.

### What stays pure

Post-collapse, every function previously exported from `src/core/act-local-ci.ts` is still:
- Free of `Effect` (just `Option`, `Predicate`, `Result` from the core Effect library for discriminated returns).
- Free of I/O (no `FileSystem`, no `ChildProcess`).
- Unit-tested with the same assertions (tests moved verbatim to `test/scripts/act-local-ci.test.ts`).

The only observable difference is the import path. External consumers: none — `src/core/index.ts`'s act-local-ci re-exports were dead code (no `src/auto-pr/*` consumes them).

## Out of scope (preserved from spec §5.4)

- Further restructuring of `scripts/act-local-ci.ts` beyond the collapse (the `act` flag-planning complexity is inherent).
- Removing `act-smoke.yml`.

## Test plan

- [ ] `bun test` passes (26 act-local-ci tests; same as before; now in one file)
- [ ] `bun run typecheck` clean
- [ ] `bun run check:code` clean
- [ ] `bun run act-local-ci -- --dry-run check` produces the same plan as before
- [ ] `bun run act-local-ci -- --dry-run integration` ditto
- [ ] `gh act` (if installed locally) still works via the `gh` backend path — no changes to that logic
- [ ] CI on this PR green (`CI / gate`, `act-smoke`)

## Risk

- **FC/IS collapse may confuse readers.** Mitigation: AGENTS.md table explicitly scopes the exception; the file-level docstring in `scripts/act-local-ci.ts` explains the layout.
- **Dead re-exports in `src/core/index.ts` may have been consumed by unknown external code.** Mitigation: this repo is a library (`auto-pr-init`, auto-pr workflows) — external consumers of `src/core/index.ts`'s ActBackend re-exports would be unusual. If any user's local fork depended on this, the restoration is one commit away.
- **`python3 -c` one-liner in YAML.** Mitigation: identical semantics to the old script; GitHub-hosted Ubuntu has python3 preinstalled (documented in spec §5.1 and preserved in the updated comment).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Watch CI**

Run: `gh pr checks --watch`
Expected: `CI / gate` green. `act-smoke` runs (it's an independent workflow, not part of gate); it should also pass.

If `act-smoke` fails: the `act` dry-run may be hitting a regression from the FC/IS collapse. Debug by comparing the argv `planActRun` produces pre-vs-post. Fix in-place.

- [ ] **Step 7: Merge**

Once approved and green, merge.

---

## Success Criteria

Per spec §9 Area E:

- `src/core/act-local-ci.ts` deleted. ✓ (Task 2)
- Tests relocated and passing. ✓ (Task 3)
- `scripts/integration-ephemeral-port.sh` deleted. ✓ (Task 5)
- `scripts/nix-run-if-missing.sh` deleted OR annotated. ✓ (Task 6 — annotated; deletion was rejected by investigation)
- `actions/cache@v5` throughout `act-smoke.yml`. ✓ (done by Area F; verified in Task 1)

Beyond the spec:

- No regressions in `act` harness behavior (same argv, same modes, same backends).
- `AGENTS.md` records the FC/IS exception explicitly.
- Docs reflect the new file layout.

## Hand-off

Area E is the final area from the 2026-04-19 audit. After this merges:
- All five audit areas are implemented.
- The `bun2nix` → `mkBunDerivation` investigation (spec §4.4) can be kicked off as a separate research spec if desired.
- `scripts/act-local-ci.ts` is now the single entrypoint for local CI — further simplification (if any) is bounded by `act`'s own complexity surface.
