# update-workflow-pins

Composite action that replaces self-referential `knirski/auto-pr/...@SHA` refs with a target commit SHA.

**Used by:** [update-workflow-pins.yml](../../workflows/update-workflow-pins.yml) on push to main when workflows or actions change.

**Loop prevention:** The workflow skips when the push commit message starts with `chore(workflows): update self-referential pins`.

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `target_sha` | `github.sha` | Commit SHA to pin to |
| `repo` | `knirski/auto-pr` | Repo slug for self-referential refs |
| `check_only` | `false` | If true, exit 1 when pins are stale (no file changes) |

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

## Notes

- Only updates `uses:` lines matching `knirski/auto-pr/<path>@<40-char-sha>`.
- Skips this action's own directory (no self-reference).
- Do not add self-referential pins to this action without excluding them from the update logic.
