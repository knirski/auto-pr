# Octokit PR Client Design

**Date:** 2026-05-01  
**Status:** Implemented (see [ADR 0014](../../adr/0014-replace-gh-pr-wrapper-with-octokit.md))

This design is implemented in the live PR client:
- [`src/auto-pr/live/pull-request-client.ts`](../../../src/auto-pr/live/pull-request-client.ts) (Octokit-backed `PullRequestClient`)
- [`test/workflow/create-or-update-pr.test.ts`](../../../test/workflow/create-or-update-pr.test.ts) (lookup/create/update and error mapping tests)

> Note: The sections below preserve the original proposal text for historical context.
> Current implementation status is defined by ADR 0014 and the code/test links above.

## Problem

`auto-pr-create-or-update-pr` currently creates and updates pull requests through a live `PullRequestClient` backed by `gh pr ...` subprocess calls. That works, but it makes the PR lifecycle depend on GitHub CLI availability, CLI output shapes, subprocess error text, and `gh` repository inference.

The project already has a `PullRequestClientService` boundary, so the live interpreter can move to GitHub's official JavaScript SDK without changing workflow orchestration.

## Decision

Add a new ADR, `docs/adr/0014-replace-gh-pr-wrapper-with-octokit.md`, recording the decision to replace the `gh`-backed PR client with Octokit for PR lookup, create, and update operations.

Use the official `octokit` package from <https://github.com/octokit/octokit.js/>. GitHub's REST scripting guide recommends Octokit for JavaScript REST API scripts: <https://docs.github.com/en/rest/guides/scripting-with-the-rest-api-and-javascript>.

## Design

Keep `PullRequestClientService` as the public application boundary:

- `findByBranch(branch)` still returns `Option<PullRequestInfo>`.
- `update(prNumber, title, bodyPath)` still updates an existing PR.
- `create(headBranch, baseBranch, title, bodyPath)` still returns the created PR URL.

Replace only the live interpreter:

- Add `octokit` as a runtime dependency.
- Resolve repository identity explicitly instead of relying on `gh` inference.
- Prefer `GITHUB_REPOSITORY`.
- Fall back to `GH_REPO`.
- Require `owner/repo` format.
- Construct Octokit with `GH_TOKEN`.
- Read PR body files through the existing Effect `FileSystem` service.
- Map SDK/API failures into existing tagged errors.

The Octokit calls should be:

- Lookup: `octokit.rest.pulls.list({ owner, repo, state: "open", head: \`${owner}:${branch}\`, per_page: 1 })`
- Update: `octokit.rest.pulls.update({ owner, repo, pull_number, title, body })`
- Create: `octokit.rest.pulls.create({ owner, repo, head, base, title, body })`

`gh act` support in `scripts/act-local-ci.ts` remains unchanged. That is local CI tooling, not GitHub API wrapping.

## ADR Scope

The ADR should document:

- Why the current `gh` wrapper is being replaced.
- Why Octokit is preferred over raw `fetch`.
- Why the tagless-final `PullRequestClientService` boundary stays unchanged.
- The operational consequence that `owner/repo` must be explicit.
- The decision to leave local `gh act` behavior alone.

## Testing

Add tests for:

- Repository config resolution from `GITHUB_REPOSITORY`.
- Repository config fallback from `GH_REPO`.
- Malformed repository config failure.
- `findByBranch` returning none for an empty PR list.
- `findByBranch` returning `PullRequestInfo` for a matching PR.
- `create` returning `html_url`.
- `update` sending title and markdown body.
- API/auth failures mapping to `PullRequestLookupError` or `PullRequestFailedError`.
- Existing create/update workflow retry behavior.

Run `bun run check` before completion.

## Non-goals

- Do not replace git subprocess usage in `GitContext`.
- Do not replace local `gh act` support.
- Do not change the public `PullRequestClientService` interface unless TypeScript forces it.
- Do not introduce a broad GitHub SDK abstraction beyond PR create/update needs.

## Consequences

Good:

- Removes runtime dependence on `gh` for PR creation.
- Removes parsing of `gh pr create` stdout.
- Uses GitHub's maintained, typed JavaScript SDK.
- Keeps workflow code stable through the existing service boundary.

Bad:

- Adds a runtime dependency.
- Requires explicit repository resolution.
- Tests need mocked Octokit/API behavior instead of command-spawner mocks.

Neutral:

- `GH_TOKEN` remains the authentication input.
- GitHub Actions permissions remain `contents: read` and `pull-requests: write` for the create job.
