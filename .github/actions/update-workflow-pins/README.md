# update-workflow-pins

Composite action that replaces self-referential `knirski/auto-pr/...@SHA` refs with a target commit SHA.

**Used by:** [update-workflow-pins.yml](../../workflows/update-workflow-pins.yml) on push to main when workflows or actions change.

**Loop prevention:** The workflow skips when the push commit message starts with `chore(workflows): update self-referential pins`.

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `target_sha` | `github.sha` | Commit SHA to pin to (write mode); comparison target when `pins_must_match_target` is true |
| `repo` | `knirski/auto-pr` | Repo slug for self-referential refs |
| `check_only` | `false` | If true, validate pins only (no file changes); see below |
| `pins_must_match_target` | `false` | With `check_only`: require the uniform pin to equal `target_sha` (strict gate, e.g. after the bot pushed) |
| `git_remote` | `origin` | Remote used to `git fetch` a missing pin commit |

## Outputs

| Output | Description |
|--------|-------------|
| `changed` | `true` if any file was modified (or would be in check_only mode) |

## Usage

```yaml
- uses: ./.github/actions/update-workflow-pins
  id: update
  with:
    target_sha: ${{ github.sha }}
```

### `check_only` validation (no writes)

When `check_only: true`, the script checks that:

1. Every self-referential `uses:` line shares **one** 40-character SHA.
2. That commit exists locally, or is **fetched** from `git_remote` (mitigates shallow clones, local act, and partial checkouts).
3. The pin is an **ancestor of `HEAD`** (so it is on the current branch history).
4. Each referenced path exists **at that commit** (`git cat-file`), so a pin cannot omit a composite action you reference.

Optional: set `pins_must_match_target: true` to also require the pin to equal `target_sha` (e.g. “automation already bumped pins to this commit”).

## Gold standard / common practice

- **Prevention:** Use `fetch-depth: 0` on [`actions/checkout`](https://github.com/actions/checkout) before any job that runs git-based checks, so ancestors are usually already present.
- **Resilience:** If the pin object is still missing (very shallow clone, odd tooling), `git fetch <remote> <sha>` is the usual fix; this script does that before `git rev-parse` / `git cat-file`.
- **Alternative:** Verify the commit exists via the [GitHub REST API](https://docs.github.com/en/rest/commits/commits?apiVersion=2022-11-28#get-a-commit) (`GET /repos/{owner}/{repo}/commits/{sha}`) with `GITHUB_TOKEN` — no local objects, but needs network and a token with `contents: read`.

## Notes

- Only updates `uses:` lines matching `knirski/auto-pr/<path>@<40-char-sha>`.
- Skips this action's own directory (no self-reference).
- Do not add self-referential pins to this action without excluding them from the update logic.
