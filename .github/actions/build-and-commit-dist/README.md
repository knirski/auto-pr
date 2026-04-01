# Build and commit dist

Builds `dist/` with Bun and commits it (using `git add -f` to override `.gitignore`). Pushes only when `dist/` changed.

**Used by:**
- [update-dist.yml](../../workflows/update-dist.yml) — main branch
- [add-dist-to-release-pr.yml](../../workflows/add-dist-to-release-pr.yml) — release PRs

**Inputs:**
- `ref` — Git ref to checkout
- `token` — Token for checkout and push
- `fetch_depth` — Optional, default `1`
- `push_branch` — Optional, default `main` (branch to push to)

**Push:** After committing `dist/`, the action `fetch`es `push_branch`, `git rebase` onto `origin/<push_branch>` (so concurrent updates to the branch are incorporated), then pushes. Retries up to 5 times with backoff if the push is rejected. Shallow checkouts are deepened (`--unshallow` or `--deepen`) so rebase can compute a merge base.

**Pins:** `actions/checkout`, `oven-sh/setup-bun`, and `actions/cache` (v5+) are SHA-pinned. Update manually when new versions release (update-workflow-pins only updates knirski/auto-pr refs).
