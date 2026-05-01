# Replace gh PR wrapper with Octokit

## Context and Problem Statement

`auto-pr-create-or-update-pr` currently depends on a live `PullRequestClient` that shells out to `gh pr view/edit/create`.

This creates avoidable runtime coupling to:

- GitHub CLI presence and version on runners.
- CLI output shapes (including URL parsing from `gh pr create` stdout).
- Subprocess error text classification.
- Implicit repository resolution behavior inside `gh`.

The workflow already depends on a tagless-final boundary (`PullRequestClientService`), so the live interpreter can change without changing workflow orchestration.

## Considered Options

* **Keep `gh` wrapper** — No migration cost, but keeps subprocess and CLI coupling in the critical PR path.
* **Use raw `fetch` against GitHub REST API** — Removes CLI dependency but requires manual request typing, pagination/shape handling, and error wrapping.
* **Use Octokit (`octokit`)** — Official GitHub JavaScript SDK with typed REST calls and stable client ergonomics.

## Decision Outcome

Chosen option: **replace the `gh`-backed live PR client with Octokit** while keeping the existing `PullRequestClientService` interface unchanged.

### Design details

- Keep `findByBranch`, `create`, and `update` signatures unchanged at the service boundary.
- Replace only `src/auto-pr/live/pull-request-client.ts` implementation.
- Resolve repository identity explicitly:
  - Prefer `GITHUB_REPOSITORY`.
  - Fall back to `GH_REPO`.
  - Require strict `owner/repo` format.
- Construct `Octokit` with `GH_TOKEN`.
- Read PR body markdown via Effect `FileSystem` and send the content in REST payloads.
- Use REST operations:
  - lookup: `octokit.rest.pulls.list({ owner, repo, state: "open", head: "${owner}:${branch}", per_page: 1 })`
  - update: `octokit.rest.pulls.update({ owner, repo, pull_number, title, body })`
  - create: `octokit.rest.pulls.create({ owner, repo, head, base, title, body })`
- Map failures to existing domain errors:
  - lookup failures -> `PullRequestLookupError`
  - create/update/config failures -> `PullRequestFailedError`

## Consequences

### Good

- Removes runtime dependence on `gh` for PR lifecycle operations.
- Removes stdout parsing for created PR URL.
- Uses GitHub-maintained, typed SDK for REST interactions.
- Preserves workflow shell behavior through unchanged tagless-final boundary.

### Bad

- Adds runtime dependency on `octokit`.
- Requires explicit repository identity (`owner/repo`) in environment.
- Test strategy moves from process-spawner mocks to Octokit API behavior doubles.

### Neutral

- `GH_TOKEN` remains the auth input.
- Local `gh act` support in `scripts/act-local-ci.ts` is unchanged.
- Workflow permissions model stays the same for create/update (`contents: read`, `pull-requests: write`).

## References

- Spec: `docs/superpowers/specs/2026-05-01-octokit-pr-client-design.md`
- GitHub REST scripting guide: <https://docs.github.com/en/rest/guides/scripting-with-the-rest-api-and-javascript>
- Octokit: <https://github.com/octokit/octokit.js/>
