# Existing PR Title in Generate-Content Prompt

**Date:** 2026-04-19  
**Status:** Implemented

## Problem

When auto-PR re-runs on a branch that already has an open PR, the AI sees only commits and diff context. It does not see the **current PR title**. That can cause unnecessary rewrites: a title the author or a prior run chose may still be accurate after new commits, but the model invents a fresh title from scratch.

## Product rule (user choice **A**)

When an existing PR title is supplied in the prompt:

- **Prefer keeping** the current title if it still accurately summarizes the branch.
- **Change** the title only when new commits clearly shift scope, fix a wrong type prefix, or make the old wording misleading.

The prompt must state this explicitly so the model does not treat the old title as disposable context.

## Decision summary

- **Hybrid resolution** of the existing title:
  1. Optional env **`AUTO_PR_EXISTING_PR_TITLE`** — non-empty value wins (tests, custom CI).
  2. Otherwise, **best-effort** `gh pr view <branch> --json title` in the workspace, when GitHub CLI can authenticate (`GH_TOKEN` or `GITHUB_TOKEN` as used by `gh`). Any failure (no PR, no auth, `gh` missing) → omit section; **never fail** generate-content for this lookup alone.
- **Pure prompt assembly:** extend **`buildDescriptionPrompt`** with an optional `existingPrTitle` string; when non-blank after trim, append a dedicated section before or after the commit list (consistent with current section order: template → diff stat → commits → **existing title** is clearest **after** commits so the model compares title vs latest commits).
- **Template copy:** update **`src/auto-pr/prompts/pr-description.txt`** with a short bullet on continuity (rule A) and that the field may be absent on first PR.
- **CI permissions:** ensure the reusable generate workflow grants enough scope for `gh pr view` on the same repo. Add **`pull-requests: read`** to **`.github/workflows/auto-pr-generate-reusable.yml`** (job or workflow `permissions`) if the current token scope is insufficient; verify against GitHub’s permission model for `GITHUB_TOKEN`.
- **Config table:** document **`AUTO_PR_EXISTING_PR_TITLE`** in **`src/auto-pr/config.ts`** env documentation block.

## Non-goals

- Changing single-commit title path (still derived from commits only).
- Persisting or merging titles outside the AI prompt (e.g. no new files besides generated `pr-title.txt`).
- Failing the workflow when lookup fails.

## Testing

- **`test/core/prompt.test.ts`:** `buildDescriptionPrompt` includes the new section when `existingPrTitle` is set; omits when empty/whitespace.
- **Generate-content tests:** where `generatePrContent` / helpers accept params, pass `existingPrTitle` and assert prompt or behavior if there is an existing hook; otherwise unit-test prompt only and one integration-style test for resolution if cheap.

## Implementation notes

- **Logging:** log at info when a title was resolved (source: env vs `gh`), and debug or silent when skipped — avoid leaking full title in error paths if redaction is a concern (title is not secret; INFO is acceptable).
- **Branch:** use the same `BRANCH` value already passed to generate-content (`github.head_ref || github.ref_name` in callers).

## Open verification

- After changing workflow permissions, run or extend **`act-smoke`** / workflow tests if they assert permission blocks.
