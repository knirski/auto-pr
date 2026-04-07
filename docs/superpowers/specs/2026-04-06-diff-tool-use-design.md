# Diff Tool Use for AI-Generated PR Descriptions

**Date:** 2026-04-06
**Status:** Implemented (see [ADR 0011](../../adr/0011-gitcontext-and-diff-tool-use.md))

## Problem

The AI that generates PR descriptions only sees commit messages (subjects + bodies). It has no access to actual code changes — no diffs, no file information, no change sizes. This limits the quality of generated descriptions, especially for risk assessment and reviewer notes.

## Decision Summary

- Introduce a `GitContext` Effect service as the single typed interface for all git read operations
- Eliminate `auto-pr-get-commits` — `generate-content` fetches all git data directly via `GitContext`
- Add tool use (Effect Toolkit) so the AI model can selectively fetch diffs during generation
- Enrich the initial prompt with `git diff --stat` output and commit hashes
- Use explicit `(baseRef, headRef)` refs throughout — no implicit `HEAD`

## Design

### GitContext Service

New file `src/auto-pr/git-context.ts`. All git read operations in one typed service. Implemented with `runCommand` internally. Requires `ChildProcessSpawner`.

```typescript
interface GitContext {
  readonly getLog:          (baseRef: string, headRef: string) => Effect<string>
  readonly getChangedFiles: (baseRef: string, headRef: string) => Effect<string>
  readonly getDiffStat:     (baseRef: string, headRef: string) => Effect<string>
  readonly getDiff:         (baseRef: string, headRef: string, path?: string) => Effect<string>
  readonly getCommitDiff:   (hash: string) => Effect<string>
}
```

- `getLog`: `git log --format=---COMMIT---%n%H%n%s%n%n%b <baseRef>..<headRef>`
- `getChangedFiles`: `git diff --name-only <baseRef>..<headRef>`
- `getDiffStat`: `git diff --stat <baseRef>..<headRef>`
- `getDiff`: `git diff <baseRef>..<headRef> [-- <path>]`
- `getCommitDiff`: `git show <hash>` (no range needed, just a hash)

The live layer is constructed with `workspace` (cwd for all git commands) baked in at layer creation time — it does not appear in method signatures.

### Elimination of get-commits

`auto-pr-get-commits` is removed entirely. All its responsibilities move into `generate-content`:

**Deleted:**
- `src/workflow/auto-pr-get-commits.ts`
- `GetCommitsConfig` and `GetCommitsConfigLayer` in `src/auto-pr/config.ts`
- `buildGetCommitsGhEntries`, `validateGetCommitsOutput`, `parseGhOutput`
- `auto-pr-get-commits` binary entry in `package.json`
- Intermediate files: `commits.txt`, `files.txt`, `subjects.txt`, `semantic_subjects.txt`

**Justification:** With `GitContext` available in `generate-content`, the file-based handoff is pure overhead — git calls are cheap local operations (no network, millisecond latency). The early-fail on zero semantic commits moves into `generate-content` (same effect — step fails, subsequent CI steps don't run).

### CommitInfo and Log Format

`CommitInfo` gains a `hash: string` field (full 40-char SHA from `%H`). The git log format changes from `--format=---COMMIT---%n%s%n%n%b` to `--format=---COMMIT---%n%H%n%s%n%n%b`. `parseCommits` extracts the full hash from each block's first line.

`getDescriptionPromptText` displays a truncated hash (first 7 chars) for readability in the prompt:

```
Commits:
- a3f9c12 feat: add session management

  Body of commit...

- 7b2e041 fix: session timeout on refresh
```

Hashes enable the `get_commit_diff` tool — the model can reference specific commits it sees in the prompt.

### Config Changes

`GeneratePrContentConfig` gains two fields:
- `defaultBranch: string` — from `DEFAULT_BRANCH` env
- `branch: string` — from `BRANCH` env

Both are already available in CI context. `baseRef` is computed as `"origin/" + defaultBranch`, `headRef` is `branch`.

### Tools and Toolkit

New file `src/auto-pr/diff-toolkit.ts`:

```typescript
const GetDiff = Tool.make("get_diff", {
  description: "Get the git diff for changed files. Provide path for one file, omit for all.",
  parameters: Schema.Struct({ path: Schema.optional(Schema.String) }),
  success: Schema.String,
  failureMode: "return"
})

const GetCommitDiff = Tool.make("get_commit_diff", {
  description: "Get the diff introduced by a specific commit by its hash.",
  parameters: Schema.Struct({ hash: Schema.String }),
  success: Schema.String,
  failureMode: "return"
})

export const DiffToolkit = Toolkit.make(GetDiff, GetCommitDiff)
```

Toolkit layer handlers call `GitContext` methods with `baseRef`/`headRef` captured from config.

### Prompt Changes

The prompt currently contains only the system prompt and commit messages. It gains a diff stat block:

```
<system prompt — updated to mention available tools>

Changed files (diff stat):
 src/auth/session.ts | 42 ++++++---
 src/auth/token.ts   |  8 ++
 2 files changed, 35 insertions(+), 15 deletions(-)

Commits:
- a3f9c12 feat: add session management

  Body...
```

The system prompt (`pr-description.txt`) gains a brief note about the two tools (`get_diff`, `get_commit_diff`) and when to use them.

### generate-content Changes

`generatePrContentFromValues` changes signature:

**From:** `(params: { commitsContent: string, filesContent: string, templateContent: string, ... })` requiring `LanguageModel`

**To:** `(params: { baseRef: string, headRef: string, templateContent: string, ... })` requiring `LanguageModel | GitContext`

Internal flow:
1. `GitContext.getLog(baseRef, headRef)` → `parseCommits` → fail if no semantic commits
2. `GitContext.getChangedFiles(baseRef, headRef)` → file list for template
3. `GitContext.getDiffStat(baseRef, headRef)` → stat for prompt
4. Build prompt: system + diffstat + commits (with hashes)
5. `generateText({ prompt, toolkit: DiffToolkit })` — model may call tools
6. Parse JSON → fill template → write `pr-title.txt` + `pr-body.md`

Pure core (`parseCommits`, `renderBodyCore`, `inferTypeOfChange`, `getDescriptionPromptText`) stays pure — takes strings, no I/O.

Layer composition for `generate-content`:
- `LanguageModel` (existing, from `aiProviderLayerFromConfig`)
- `GitContext` (new, requires `ChildProcessSpawner`)
- `ChildProcessSpawner` (new for this step)
- `DiffToolkit` layer (requires `GitContext`)

### auto-pr-run.ts Simplification

Pipeline goes from:

```
get-commits → parse GITHUB_OUTPUT → generate-content → create-or-update-pr
```

to:

```
generate-content → create-or-update-pr
```

No temp file for GITHUB_OUTPUT, no parsing between steps.

### CI Workflow Changes

`auto-pr-generate-reusable.yml` drops the get-commits step:

```yaml
# Before: two steps
- run: auto-pr-get-commits
- run: auto-pr-generate-content

# After: one step
- run: auto-pr-generate-content
  env:
    DEFAULT_BRANCH: ${{ inputs.default_branch }}
    BRANCH: ${{ github.head_ref || github.ref_name }}
```

The two-workflow security split (generate vs. create) is unaffected — it addresses CWE-829 (untrusted checkout vs. privileged permissions), which is orthogonal to this change.

Artifact still uploads `pr-title.txt` and `pr-body.md` for the create job.

### Testing

- `GitContext`: unit tests with mock `ChildProcessSpawner` returning canned git output
- `DiffToolkit`: unit tests with mock `GitContext` layer
- `generate-content`: existing tests adapted to provide mock `GitContext` instead of mock file contents
- `parseCommits`: updated to handle hash extraction, tested with new format
- Integration tests: real git repo + real AI provider (existing pattern)

## What Does Not Change

- Pure core functions: `parseCommits`, `renderBodyCore`, `inferTypeOfChange`, `getDescriptionPromptText`, `fitConventionalTitleToLengthLimit` — still pure, still take strings
- `auto-pr-create-or-update-pr` — unchanged, still reads `pr-title.txt` + `pr-body.md`
- Two-workflow CI security model (generate unprivileged / create privileged)
- AI provider layer (`aiProviderLayerFromConfig`) — unchanged
- `TitleDescriptionSchema` and JSON parse + retry logic — unchanged
- Fallback to commit-derived content on persistent AI failure — unchanged
