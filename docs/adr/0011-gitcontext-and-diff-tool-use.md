# GitContext service and AI diff tool use

## Context and Problem Statement

The AI model that generates PR descriptions only receives commit messages — subjects and bodies. It has no visibility into actual code changes: no diffs, no change sizes, no file context. For multi-commit branches this produces shallow risk assessments and generic reviewer notes.

Additionally, `auto-pr-get-commits` was a separate binary whose sole purpose was to write `commits.txt`, `files.txt`, and related artifacts to disk so `auto-pr-generate-content` could read them back. This file-based handoff added pipeline complexity (two binaries, intermediate disk writes, `GITHUB_OUTPUT` parsing) with no architectural benefit — git calls are cheap local operations with millisecond latency.

## Considered Options

* **Pre-compute and inject full diffs** — Fetch the entire diff upfront and include it in the prompt. Simple but wasteful: large branches produce enormous prompts; the model sees everything even when only a few files are relevant.
* **Tool use: model-driven selective diff fetching** — Provide `get_diff` and `get_commit_diff` as callable tools. The model decides what to fetch based on the commit messages and diff stat it already has.
* **Keep file-based handoff, add diff reading** — Extend the existing `get-commits` artifact approach to also write diff files. Preserves backwards compatibility but amplifies the existing architectural problem.

## Decision Outcome

Chosen option: **tool use with a `GitContext` service**, because it gives the model access to code context on demand without pre-computing diffs that may never be read, while also eliminating the file-based handoff entirely.

Two changes ship together because they share a prerequisite: once `generate-content` has direct git access via `GitContext`, the intermediate `get-commits` step is pure overhead and can be deleted.

### Consequences

* **Good:** AI model can fetch targeted diffs (one file, one commit) instead of receiving a full-branch dump upfront. This keeps prompt size bounded while unlocking richer risk and reviewer notes.
* **Good:** `auto-pr-get-commits` binary eliminated — pipeline is `generate-content → create-or-update-pr`. No intermediate disk artifacts, no `GITHUB_OUTPUT` parsing between steps.
* **Good:** `GitContext` is a typed Effect service — all git read operations go through one interface, making the generate-content function testable with a mock and traceable via `Effect.fn` spans.
* **Good:** Prompt is enriched with `git diff --stat` output and 7-char commit hash prefixes at no extra cost, giving the model orientation even without tool calls.
* **Neutral:** The generate job now requires git to be checked out with full history (`fetch-depth: 0`), which was already the case.
* **Neutral:** `DEFAULT_BRANCH` and `BRANCH` env vars must be set for `generate-content` (previously handled by the `get-commits` step reading from `GITHUB_OUTPUT`). CI workflow updated to pass both.

### Design

**`GitContext` service** (`src/auto-pr/git-context.ts`): wraps five git read operations (`getLog`, `getChangedFiles`, `getDiffStat`, `getDiff`, `getCommitDiff`). `workspace` is baked in at layer construction time via `GitContextLive(workspace)`. All methods use `Effect.fn` named spans for tracing.

**`DiffToolkit`** (`src/auto-pr/diff-toolkit.ts`): `Tool.make` + `Toolkit.make` from `effect/unstable/ai`. Two tools:
- `get_diff` — optional `path` param; calls `GitContext.getDiff(baseRef, headRef, path?)`
- `get_commit_diff` — required `hash` param; calls `GitContext.getCommitDiff(hash)`

Handlers capture `baseRef`/`headRef` at layer construction via `makeDiffToolkitLayer(baseRef, headRef)`.

**`CommitInfo.hash`**: `parseCommits` extracts the full 40-char SHA from the new `%H` log format field; `getDescriptionPromptText` shows a 7-char prefix before each subject line.

**CI change**: the `get-commits` step replaced by a single inline bash count (`git log | grep -cvE '^Merge '`) to drive the llama.cpp startup conditional. The two-workflow security split (generate unprivileged / create privileged) is unaffected — see [ADR 0002](0002-two-phase-auto-pr-workflow.md).

## Resilience additions (2026-04)

Two hardening changes were added after the initial tool-use implementation.

### Git command timeouts

All `GitContext` methods apply a hard 30-second timeout (`GIT_COMMAND_TIMEOUT`) via `Effect.timeout`. Without it, a `git` process waiting for credentials on a remote ref (e.g. if `extendEnv` accidentally inherits a credential helper) would block the workflow indefinitely. The timeout maps to a named error message (`git <subcommand> timed out after 30s`); non-timeout errors are forwarded via `unknownToMessage`.

30 seconds was chosen as comfortably above worst-case local repo latency (git log on a 10-year repo takes <1s; git show on a large binary commit takes <5s) while still catching hangs within the CI job timeout.

### Diff sanitization at the DiffToolkit boundary

`DiffToolkit` applies `sanitizeDiffForAi` (`src/core/sanitize-diff.ts`) to every tool response before returning it to the model. The sanitizer:

- Strips binary file hunks entirely (binary diffs carry no information the model can use and inflate token counts)
- Truncates per-file and total output to configurable size caps

**Why at the DiffToolkit boundary, not in GitContext or the prompt builder:**
- `GitContext` is a general-purpose git read service; imposing AI-specific limits there would leak concerns.
- Applying it in the prompt builder would require passing raw diffs up the call stack and then trimming — the model would still spend tool-call round trips on data that gets discarded.
- The toolkit boundary is the natural place: it owns the contract between the model's tool calls and the git data, and it already handles error responses (`[TOOL_ERROR]` prefix).

## References

* Design spec: [docs/superpowers/specs/2026-04-06-diff-tool-use-design.md](../superpowers/specs/2026-04-06-diff-tool-use-design.md)
* Implementation: `src/auto-pr/git-context.ts`, `src/auto-pr/diff-toolkit.ts`, `src/core/sanitize-diff.ts`, `src/workflow/auto-pr-generate-content.ts`
* Related: [ADR 0001](0001-functional-core-imperative-shell.md) (Effect / FC-IS), [ADR 0002](0002-two-phase-auto-pr-workflow.md) (two-phase CI), [ADR 0007](0007-ai-abstraction-layer.md) (AI provider abstraction), [ADR 0013](0013-transient-vs-permanent-ai-errors.md) (AI error classification)
