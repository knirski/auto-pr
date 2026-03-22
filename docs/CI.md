# CI Workflows

This repo uses GitHub Actions with built-in path filters. No third-party path-filter actions.

## CI overview

| When | What runs |
|------|-----------|
| Push to `ai/**` | auto-pr creates/updates PR |
| PR to main (code changes) | ci → check, dependency-review |
| PR to main (docs only) | ci-docs → check-docs |
| PR to main (.github only) | ci-workflows → check (actionlint, shellcheck, shfmt) |
| PR to main (nix/deps) | ci-nix → nix flake check (x64 + arm64) + bun.nix update |
| PR to main (release-please) | ci-release-please → check |
| Push to main | release-please, update-workflow-pins (when workflows/actions change), update-dist (when src/pkg/build/bun.lock change), scorecard (if configured) |
| Manual | update-bun-nix, update-flake-lock, update-workflow-pins, update-dist |
| Weekly | update-flake-lock (Sun), scorecard (Sat), stale (Mon) |

## First-time setup

Before CI can run fully:

1. **GitHub App** — Create an app with Contents and Pull requests (Read and write). Add `APP_ID` and `APP_PRIVATE_KEY` to **Settings → Secrets and variables → Actions**. Required for auto-pr, release-please, update-dist, and add-dist-to-release-pr.
2. **Codecov** (optional) — Add `CODECOV_TOKEN` for coverage badge. Get from [codecov.io](https://codecov.io). Without it, the upload step is skipped; CI still passes.
3. **Labels** — Run `./scripts/create-labels.sh` so update-flake-lock can open PRs (needs `dependencies`, `nix`, `automated`) and issue templates work (`bug`, `enhancement`, `good first issue`).
4. **Branch protection** — Require `check / check` before merging to main.

## Workflows

| Workflow | Trigger | Path filter | Jobs |
|----------|---------|-------------|------|
| [auto-pr.yml](../.github/workflows/auto-pr.yml) | push → `ai/**` | — | auto-pr (creates/updates PR from conventional commits) |
| [ci.yml](../.github/workflows/ci.yml) | push, pull_request → main | `paths-ignore: '**/*.md', '.github/**'` | check, dependency-review |
| [ci-docs.yml](../.github/workflows/ci-docs.yml) | push, pull_request → main | `paths: '**/*.md'` | check (pass-through) |
| [ci-workflows.yml](../.github/workflows/ci-workflows.yml) | push, pull_request → main | `paths: '.github/**'` | check |
| [ci-nix.yml](../.github/workflows/ci-nix.yml) | push, pull_request → main | `paths: **/*.nix, package*.json, bun.lock, flake.lock` | nix |
| [ci-release-please.yml](../.github/workflows/ci-release-please.yml) | pull_request → main | `paths: .release-please-manifest.json` | check |
| [update-bun-nix.yml](../.github/workflows/update-bun-nix.yml) | workflow_dispatch | — | update-bun-nix (runs on default branch, pushes bun.nix to main) |
| [update-workflow-pins.yml](../.github/workflows/update-workflow-pins.yml) | push → main, workflow_dispatch | `paths: .github/workflows/**`, `.github/actions/**` | update-workflow-pins (updates self-referential pins) |
| [update-dist.yml](../.github/workflows/update-dist.yml) | push → main, workflow_dispatch | `paths: src/**`, package.json, scripts/build.ts, bun.lock | update-dist (builds and commits dist for Node-only GitHub installs) |
| [add-dist-to-release-pr.yml](../.github/workflows/add-dist-to-release-pr.yml) | pull_request → main | `paths: .release-please-manifest.json`, package.json, CHANGELOG.md | add-dist (adds dist to release PR before merge so tags include it) |
| [update-flake-lock.yml](../.github/workflows/update-flake-lock.yml) | workflow_dispatch, schedule | — | update-flake-lock |
| [release-please.yml](../.github/workflows/release-please.yml) | push → main | — | release-please (creates release PRs) |
| [codeql.yml](../.github/workflows/codeql.yml) | push, pull_request → main | `paths-ignore: **/*.md, docs/**` | analyze |
| [codeql-docs.yml](../.github/workflows/codeql-docs.yml) | pull_request → main | `paths: **/*.md, docs/**` | analyze (pass-through) |
| [scorecard.yml](../.github/workflows/scorecard.yml) | push → main, schedule (Sat 01:30 UTC) | — | Scorecard analysis |
| [stale.yml](../.github/workflows/stale.yml) | schedule (Mon 00:00 UTC), workflow_dispatch | — | Mark stale issues/PRs |

**auto-pr.yml** runs on push to `ai/**` branches (including forks). Two workflows: generate (unprivileged checkout + content) and create (trusted checkout + PR). Security model: [docs/WORKFLOW_SECURITY.md](WORKFLOW_SECURITY.md). Forks need `APP_ID` and `APP_PRIVATE_KEY` in their repo secrets to succeed. See [docs/INTEGRATION.md](INTEGRATION.md).

**ci.yml** runs when any non-.md, non-.github file changes. Skips when only docs or only .github changes.

**ci-docs.yml** is complementary: runs when only `*.md` files change. Reports a passing `check` job so branch protection allows merge.

**ci-workflows.yml** is complementary: runs when only `.github/**` changes. Minimal check (actionlint, shellcheck, shfmt on .github/actions). Reports a passing `check` job so branch protection allows merge.

**ci-nix.yml** runs only when Nix or dependency files change. Uses upstream Nix ([cachix/install-nix-action](https://github.com/cachix/install-nix-action)), runs statix and deadnix via `nix flake check`, and auto-updates `bun.nix` for same-repo PRs and main. Uses the same GitHub App as auto-pr for the push so CI triggers on the new commit (GITHUB_TOKEN pushes do not trigger workflows).

**update-bun-nix.yml** runs on manual trigger (workflow_dispatch). Use when `main` has a stale `bun.nix` (e.g. after merging a lockfile change from a fork). Runs on the default branch and pushes the updated `bun.nix` to `main`. For same-repo PRs, ci-nix handles updates automatically.

**update-workflow-pins.yml** runs on push to main when workflows or actions change, and on workflow_dispatch. Updates self-referential `knirski/auto-pr/...@SHA` refs to the current commit. Loop prevention: skips when the push commit message starts with `chore(workflows): update self-referential pins`. Only runs in knirski/auto-pr (skips forks). See [.github/actions/update-workflow-pins/README.md](../.github/actions/update-workflow-pins/README.md).

**update-dist.yml** runs on push to main when `src/`, `package.json`, `scripts/build.ts`, or `bun.lock` change, and on workflow_dispatch. Uses [build-and-commit-dist](../.github/actions/build-and-commit-dist) to build and commit `dist/` so `npx -p github:knirski/auto-pr` works for Node-only users (no Bun). `dist/` is in `.gitignore` locally—the action uses `git add -f dist/` to override. Loop prevention: skips when commit message starts with `chore: update dist`. Only runs in knirski/auto-pr. See [Dist and .gitignore](#dist-and-gitignore).

**add-dist-to-release-pr.yml** runs on release-please PRs (when `.release-please-manifest.json`, `package.json`, or `CHANGELOG.md` change). Uses build-and-commit-dist to add `dist/` to the PR branch so the merge commit—and thus the release tag—includes it. Fixes `npx -p github:knirski/auto-pr#v0.1.2` for Node-only users.

**update-flake-lock.yml** runs weekly (Sunday 00:00 UTC) and on manual trigger. Updates `flake.lock` and opens a PR. Requires `dependencies`, `nix`, and `automated` labels. Run `./scripts/create-labels.sh` before the first scheduled run.

**release-please.yml** runs on push to main. Creates release PRs from conventional commits; updates version and CHANGELOG. Requires `APP_ID` and `APP_PRIVATE_KEY` secrets.

**codeql.yml** runs when non-docs code changes. Uses security-extended queries for actions and javascript-typescript. Skips for docs-only changes.

**codeql-docs.yml** is complementary to codeql.yml: runs when only docs change. CodeQL skips for docs (paths-ignore); this reports passing status so code scanning allows merge.

**scorecard.yml** runs on push to main and weekly (Saturday 01:30 UTC). Publishes OpenSSF Scorecard results to code scanning.

**stale.yml** runs weekly (Monday 00:00 UTC) and on manual trigger. Marks issues/PRs stale after 180 days, closes after 180 more. Exempts `pinned` and `security` labels.

## Run CI locally

`bun run check:ci` runs the check workflow locally via [act](https://github.com/nektos/act) in Docker. Requires Docker and either `gh extension install nektos/gh-act` or `act` installed. See [CONTRIBUTING.md](../CONTRIBUTING.md#run-ci-locally-full-parity).

Pre-push runs `check:code` before each push (Bun deps only). See [CONTRIBUTING.md](../CONTRIBUTING.md#pre-push-hook).

## Link verification

`bun run check:just-links` runs lychee to verify links in the repo. Can fail on broken external URLs (404s, redirects). Use `check:with-links` to run full check plus link verification. Both check.yml and check-docs.yml run lychee with `continue-on-error: true` so link failures do not block merge. Lychee accepts 200 and 429 (rate limit) via `--accept 200,429`.

## Branch Protection

ci.yml, ci-docs.yml, and ci-workflows.yml report **`check / check`**. Configure main branch protection to require:

- **Status checks that are required:** `check / check`

Do not require `dependency-review` (PR-only) or `nix` (path-filtered); they would block when skipped.

## Dependency review and vulnerability detection

**dependency-review** runs on PRs (except Dependabot Bun PRs). For Dependabot Bun PRs, the job is skipped because GitHub's dependency graph may not yet support `bun.lock`. Vulnerability detection is covered by **bun audit** in the check job (`bun audit --audit-level=high` runs on every PR, including Dependabot Bun PRs).

**License checking:** dependency-review can flag license changes when it runs. When it is skipped (Dependabot Bun PRs), license changes are not automatically checked. To audit licenses manually or in CI, consider tools like `license-checker` or `manypkg check licenses`; add to the check workflow if desired.

## Troubleshooting: "check / check" waiting for status

When ci-nix pushes a bun.nix update, the PR head changes to a new commit. The required check must run on that new commit. If you see "waiting for status to be reported":

1. **Wait 1–2 minutes** — The push triggers the check workflow; it may take a moment to start.
2. **Re-run workflows** — If the check still hasn't run, use "Re-run all jobs" from the Actions tab.
3. **Manual trigger** — Push an empty commit: `git commit --allow-empty -m "ci: trigger workflows" && git push`.

## Fork PRs

CI cannot push to forks. If the nix job fails (ci-nix.yml), update locally: `nix run .#update-bun-nix`, then commit and push. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Workflow pin automation

Self-referential pins (`knirski/auto-pr/...@SHA`) are updated automatically by [update-workflow-pins.yml](../.github/workflows/update-workflow-pins.yml) on push to main when workflows or actions change. Manual run: **Actions → Update workflow pins → Run workflow**. Rationale: [ADR 0001](adr/0001-workflow-pin-automation.md).

**When automation runs:** Push to main with changes under `.github/workflows/` or `.github/actions/`. The workflow updates all pins to the current commit and pushes. Loop prevention: it skips when the push came from itself (commit message starts with `chore(workflows): update self-referential pins`).

**Manual update (if needed):** If automation didn't run (e.g. merge only touched `src/`), run the workflow manually or update pins yourself. See [.github/actions/update-workflow-pins/README.md](../.github/actions/update-workflow-pins/README.md).

## Dist and .gitignore

`dist/` is listed in `.gitignore` so local diffs and PRs stay clean. The [update-dist.yml](../.github/workflows/update-dist.yml) workflow (via [build-and-commit-dist](../.github/actions/build-and-commit-dist)) builds `dist/` in CI and commits it using `git add -f dist/`—the `-f` flag overrides `.gitignore`. This allows:

- **Local dev:** `dist/` is gitignored. If you branch from main (after update-dist has run), `dist/` may be tracked; running `bun run build` then shows `modified: dist/` in status—do not commit it, the workflow updates main after merge.
- **Contributors testing on knirski/auto-pr:** When the workflow runs in knirski/auto-pr (e.g. on ai/* branches), it uses the workspace source (`bun run`) instead of the npx package. That avoids requiring committed `dist/` on the branch and prevents "Package does not provide binary" when testing changes before merge.
- **Node-only GitHub installs:** `npx -p github:knirski/auto-pr auto-pr-init` works without Bun because `dist/` is committed by CI.
- **`prepare` script:** Runs `bun run build`; if Bun is unavailable, no-ops (`|| exit 0`). Works for Node-only (npm) and Bun-only (bun) installs; Node-only use the committed `dist/` from the repo.

**Do not remove `-f`** from `git add -f dist/` in the action; without it, ignored files would not be staged.

**Version tags:** [add-dist-to-release-pr.yml](../.github/workflows/add-dist-to-release-pr.yml) adds `dist/` to release-please PRs before merge, so tagged commits (e.g. `npx -p github:knirski/auto-pr#v0.1.2`) include it. **Before merging a release PR**, wait for "Add dist to release PR" to complete so the tagged commit includes `dist/`.
