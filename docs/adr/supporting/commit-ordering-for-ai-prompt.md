# Commit ordering and noise filtering for AI prompt

## Problem

`getDescriptionPromptText` passes commits to the AI in reverse-chronological order
(newest first, as `git log` produces). When the most recent commits are housekeeping
(`chore`, `style`, `refactor`, `ci`, `test`, `docs`) the model anchors on them and
produces a description about infra/tooling instead of the actual feature changes.
This is a position-bias effect: tokens near the start of a long context receive
disproportionate weight.

## Proposed changes

Both changes apply inside `getDescriptionPromptText` in `src/core/fill-pr-template-core.ts`
(or a thin pre-processing step before it is called). They are independent and can be
implemented together in one commit.

### 1. Sort commits by type priority before building the prompt

Define a priority order that puts user-visible changes first:

```
feat > fix > perf > revert > refactor > test > docs > build > ci > chore > style
```

Commits without a conventional type (no `type` field) sort after `feat`/`fix` and
before infrastructure types, on the assumption they are substantive but unclassified.

Implementation: sort the `CommitInfo[]` array by `COMMIT_TYPE_PRIORITY[c.type ?? ""]`
before passing it to `getDescriptionPromptText`. Stable sort so relative order within
the same type is preserved (chronological within a bucket).

### 2. Strip noise commits from the prompt

Commits whose type is `chore`, `style`, `ci`, `build`, or `test` carry almost no
information about *what the PR does* from a reviewer's perspective. Strip them from
the list passed to the AI.

**Exception:** if stripping would leave zero commits (e.g. a pure refactor PR), fall
back to passing all commits so the model has something to work with.

The stripped commits are still used everywhere else — `inferTypeOfChange`,
`getChanges` (the "Changes made" list in the PR body), and the fallback path — only
the AI prompt input is narrowed.

## Where to make the change

- **`src/core/fill-pr-template-core.ts`**: add `sortCommitsForPrompt` and
  `filterNoiseCommits` pure functions next to the existing `filterMergeCommits`.
- **`src/workflow/auto-pr-generate-content.ts`**: apply both before the
  `getDescriptionPromptText(filtered)` call (currently around line 360).

## What this does not fix

- Models can still mis-describe PRs with many commits of the same high-priority type.
- Does not address the model re-generating on every push — a separate problem.
- A prompt instruction to "focus on feat/fix" is a complementary improvement but
  should not replace the structural fix; prompt instructions are fragile under
  high noise-to-signal ratios.
