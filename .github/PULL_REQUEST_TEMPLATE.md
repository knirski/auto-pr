<!--
  Creating manually? Replace each {{placeholder}} below with your content.
  Using fill-pr-template? Run via auto-pr workflow or: npx auto-pr-fill-pr-template --log-file <path> --files-file <path>
  See [docs/PR_TEMPLATE.md](https://github.com/knirski/auto-pr/blob/main/docs/PR_TEMPLATE.md)
-->

## Description

<!-- What does this PR do and why? Provide context, not just a restatement of the title. -->

{{description}}

## Type of change

<!-- Choose one: Bug fix | New feature | Breaking change | Documentation update | Chore -->

**{{typeOfChange}}**. See [Conventional Commits](https://www.conventionalcommits.org/).

## Changes made

<!-- List specific changes. Omit for trivial PRs. -->

{{changes}}

## How to test

<!-- Step-by-step instructions for reviewers. Use "N/A" for docs-only or trivial changes. -->

{{howToTest}}

## Checklist

- [{{checklistConventional}}] My commits follow [Conventional Commits](https://www.conventionalcommits.org/)
- [ ] I have run `bun run check` and fixed any issues
- [{{checklistDocs}}] I have updated the documentation if needed
- [{{checklistTests}}] I have added or updated tests for my changes
- [ ] If this PR touches `.github/workflows/auto-pr*.yml` or `.github/actions/setup-runtime/`, I will update workflow pins on main after merge (see [docs/CI.md](../docs/CI.md#workflow-pin-maintenance-sha-updates))

## Related issues

<!-- Use "Closes #123" to auto-close on merge. Leave blank if none. -->

{{relatedIssues}}

## Breaking changes

<!-- Only if Type of change is "Breaking change". Leave blank otherwise. -->

{{breakingChanges}}
