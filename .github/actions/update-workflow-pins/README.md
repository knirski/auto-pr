# update-workflow-pins

Composite action that replaces self-referential `knirski/auto-pr/...@SHA` refs with a target commit SHA.

**Used by:**

- [update-workflow-pins.yml](../../workflows/update-workflow-pins.yml) on push to main when workflows or actions change (writes pins and pushes).
- [check.yml](../../workflows/check.yml) and [check-workflows.yml](../../workflows/check-workflows.yml) with `check_only: true` so every run fails if self-referential pins are inconsistent: more than one SHA, an unknown commit, a commit that is not an ancestor of `HEAD`, or a `uses:` path missing at the pinned commit (catches broken nested pins such as an action added only on a branch while refs still pointed at an older tree).

**Loop prevention:** The update workflow skips when the push commit message starts with `chore(workflows): update self-referential pins`.

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `target_sha` | `github.sha` | Commit SHA to pin to (write mode); comparison target when `pins_must_match_target` is true |
| `repo` | `knirski/auto-pr` | Repo slug for self-referential refs |
| `check_only` | `false` | If true, exit 1 when pins fail validation (no file changes); see check_only behavior below |

## Outputs

| Output | Description |
|--------|-------------|
| `changed` | `true` if any file was modified (or would be in check_only mode) |

## Usage

**Apply pins (e.g. locally via `act`, or implicitly on main via the update workflow):**

```yaml
- uses: ./.github/actions/update-workflow-pins
  id: update
  with:
    target_sha: ${{ github.sha }}
```

**Validate pins (CI):** all `uses: ... knirski/auto-pr/...@<sha>` lines must use the **same** 40-char SHA; that commit must exist, be an **ancestor of `HEAD`**, and contain every referenced workflow or action path (so a pin cannot point at a tree that lacks a composite you reference).

```yaml
- uses: ./.github/actions/update-workflow-pins
  with:
    check_only: 'true'
```

**Local `check_only`:** Export `INPUT_CHECK_ONLY=true`, run from repo root, and set `GITHUB_SHA="$(git rev-parse HEAD)"`. Writing to `GITHUB_OUTPUT` is optional; if unset, no `changed=` line is appended (useful for `bash -c` one-liners). Example:

```bash
GITHUB_SHA=$(git rev-parse HEAD) INPUT_CHECK_ONLY=true bash .github/actions/update-workflow-pins/update-pins.sh
```

`bun run lint:scripts` runs [scripts/smoke-update-pins-check-only.sh](../../../scripts/smoke-update-pins-check-only.sh) so verify logic is exercised with the current tree.

**Pre-commit (Lefthook):** When you stage `.github/**/*.yml`, `.github/**/*.sh`, or the smoke script, [lefthook.yml](../../../lefthook.yml) runs the same smoke script before the commit—after [check-no-dist-staged](../../../scripts/check-no-dist-staged.sh). Run `bun x lefthook install` once per clone.

## Notes

- Only updates `uses:` lines matching `knirski/auto-pr/<path>@<40-char-sha>`.
- Skips this action's own directory (no self-reference).
- Do not add self-referential pins to this action without excluding them from the update logic.
