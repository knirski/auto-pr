<!--
  Creating manually? Replace each {{placeholder}} below with your content.
  Using fill-pr-template? Run via auto-pr workflow or: npx -p github:knirski/auto-pr auto-pr-fill-pr-template --log-file <path> --files-file <path>
  See [docs/PR_TEMPLATE.md](https://github.com/knirski/auto-pr/blob/main/docs/PR_TEMPLATE.md)
-->

## Description

<!-- Narrative: why and what reviewers should focus on. With auto-pr, this is AI-filled from commits; commit subjects appear under "Changes made" below—no need to repeat them here. -->

{{description}}

## Type of change

<!-- Choose one: Bug fix | New feature | Breaking change | Documentation update | Chore -->

**{{typeOfChange}}**. See [Conventional Commits](https://www.conventionalcommits.org/).

## Changes made

<!-- List specific changes. Omit for trivial PRs. -->

{{changes}}

## How to test

<!-- Step-by-step instructions for reviewers. Replace this block with project-specific commands (for example `npm run check` or `pytest`). For docs-only or trivial changes you can use "N/A" or delete the steps below. -->

1. Run the relevant tests or checks.
2. Add another step if needed.

## Checklist

- [{{checklistConventional}}] My commits follow [Conventional Commits](https://www.conventionalcommits.org/)
- [ ] I have run `bun run check` and fixed any issues
- [{{checklistDocs}}] I have updated the documentation if needed
- [{{checklistTests}}] I have added or updated tests for my changes

## Related issues

<!-- Use "Closes #123" to auto-close on merge. Leave blank if none. -->

{{relatedIssues}}

## Breaking changes

<!-- Only if Type of change is "Breaking change". Leave blank otherwise. -->

{{breakingChanges}}
