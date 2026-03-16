# CI Workflows

This repo uses GitHub Actions with built-in path filters. No third-party path-filter actions.

## CI overview

| When | What runs |
|------|-----------|
| Push to `ai/**` | auto-pr creates/updates PR |
| PR to main (code changes) | ci → check, dependency-review |
| PR to main (docs only) | ci-docs → check-docs |
| PR to main (nix/deps) | ci-nix → nix flake check (x64 + arm64) + npmDepsHash update |
| PR to main (release-please) | ci-release-please → check |
| Push to main | release-please, scorecard (if configured) |
| Manual | update-nix-hash, update-flake-lock |
| Weekly | update-flake-lock (Sun), scorecard (Sat), stale (Mon) |

## First-time setup

Before CI can run fully:

1. **GitHub App** — Create an app with Contents and Pull requests (Read and write). Add `APP_ID` and `APP_PRIVATE_KEY` to **Settings → Secrets and variables → Actions**. Required for auto-pr and release-please.
2. **Codecov** (optional) — Add `CODECOV_TOKEN` for coverage badge. Get from [codecov.io](https://codecov.io). Without it, the upload step is skipped; CI still passes.
3. **Labels** — Run `./scripts/create-labels.sh` so update-flake-lock can open PRs (needs `dependencies`, `nix`, `automated`) and issue templates work (`bug`, `enhancement`, `good first issue`).
4. **Branch protection** — Require `check / check` before merging to main.

## Workflows

| Workflow | Trigger | Path filter | Jobs |
|----------|---------|-------------|------|
| [auto-pr.yml](../.github/workflows/auto-pr.yml) | push → `ai/**` | — | auto-pr (creates/updates PR from conventional commits) |
| [ci.yml](../.github/workflows/ci.yml) | push, pull_request → main | `paths-ignore: '**/*.md'` | check, dependency-review |
| [ci-docs.yml](../.github/workflows/ci-docs.yml) | push, pull_request → main | `paths: '**/*.md'` | check (pass-through) |
| [ci-nix.yml](../.github/workflows/ci-nix.yml) | push, pull_request → main | `paths: **/*.nix, package*.json, flake.lock` | nix |
| [ci-release-please.yml](../.github/workflows/ci-release-please.yml) | pull_request → main | `paths: .release-please-manifest.json` | check |
| [update-nix-hash.yml](../.github/workflows/update-nix-hash.yml) | workflow_dispatch | — | update-hash (runs on default branch, pushes hash to main) |
| [update-flake-lock.yml](../.github/workflows/update-flake-lock.yml) | workflow_dispatch, schedule | — | update-flake-lock |
| [release-please.yml](../.github/workflows/release-please.yml) | push → main | — | release-please (creates release PRs) |
| [codeql.yml](../.github/workflows/codeql.yml) | push, pull_request → main | `paths-ignore: **/*.md, docs/**` | analyze |
| [codeql-docs.yml](../.github/workflows/codeql-docs.yml) | pull_request → main | `paths: **/*.md, docs/**` | analyze (pass-through) |
| [scorecard.yml](../.github/workflows/scorecard.yml) | push → main, schedule (Sat 01:30 UTC) | — | Scorecard analysis |
| [stale.yml](../.github/workflows/stale.yml) | schedule (Mon 00:00 UTC), workflow_dispatch | — | Mark stale issues/PRs |

**auto-pr.yml** runs on push to `ai/**` branches (non-forks). Creates or updates a PR with title and body from conventional commits; Ollama generates description for 2+ commits. See [docs/INTEGRATION.md](INTEGRATION.md).

**ci.yml** runs when any non-.md file changes. Skips when only docs change.

**ci-docs.yml** is complementary: runs when only `*.md` files change. Reports a passing `check` job so branch protection allows merge.

**ci-nix.yml** runs only when Nix or dependency files change. Uses upstream Nix ([cachix/install-nix-action](https://github.com/cachix/install-nix-action)), runs statix and deadnix via `nix flake check`, and auto-updates `npmDepsHash` in `default.nix` for same-repo PRs and main. Uses the same GitHub App as auto-pr for the push so CI triggers on the new commit (GITHUB_TOKEN pushes do not trigger workflows).

**update-nix-hash.yml** runs on manual trigger (workflow_dispatch). Use when `main` has a stale `npmDepsHash` (e.g. after merging a lockfile change from a fork). Runs on the default branch and pushes the updated hash to `main`. For same-repo PRs, ci-nix handles updates automatically.

**update-flake-lock.yml** runs weekly (Sunday 00:00 UTC) and on manual trigger. Updates `flake.lock` and opens a PR. Requires `dependencies`, `nix`, and `automated` labels. Run `./scripts/create-labels.sh` before the first scheduled run.

**release-please.yml** runs on push to main. Creates release PRs from conventional commits; updates version and CHANGELOG. Requires `APP_ID` and `APP_PRIVATE_KEY` secrets.

**codeql.yml** runs when non-docs code changes. Uses security-extended queries for actions and javascript-typescript. Skips for docs-only changes.

**codeql-docs.yml** is complementary to codeql.yml: runs when only docs change. CodeQL skips for docs (paths-ignore); this reports passing status so code scanning allows merge.

**scorecard.yml** runs on push to main and weekly (Saturday 01:30 UTC). Publishes OpenSSF Scorecard results to code scanning.

**stale.yml** runs weekly (Monday 00:00 UTC) and on manual trigger. Marks issues/PRs stale after 180 days, closes after 180 more. Exempts `pinned` and `security` labels.

## Run CI locally

`npm run check:ci` runs the check workflow locally via [act](https://github.com/nektos/act) in Docker. Requires Docker and either `gh extension install nektos/gh-act` or `act` installed. See [CONTRIBUTING.md](../CONTRIBUTING.md#run-ci-locally-full-parity).

Pre-push runs `check:code` before each push (npm deps only). See [CONTRIBUTING.md](../CONTRIBUTING.md#pre-push-hook).

## Branch Protection

Both ci.yml and ci-docs.yml report **`check / check`**. Configure main branch protection to require:

- **Status checks that are required:** `check / check`

Do not require `dependency-review` (PR-only) or `nix` (path-filtered); they would block when skipped.

## Troubleshooting: "check / check" waiting for status

When ci-nix pushes an npmDepsHash update, the PR head changes to a new commit. The required check must run on that new commit. If you see "waiting for status to be reported":

1. **Wait 1–2 minutes** — The push triggers the check workflow; it may take a moment to start.
2. **Re-run workflows** — If the check still hasn't run, use "Re-run all jobs" from the Actions tab.
3. **Manual trigger** — Push an empty commit: `git commit --allow-empty -m "ci: trigger workflows" && git push`.

## Fork PRs

CI cannot push to forks. If the nix job fails (ci-nix.yml), update locally: `nix run .#update-npm-deps-hash` (or `npm run update-nix-hash -- <hash>` using the hash from the failed job), then commit and push. See [CONTRIBUTING.md](../CONTRIBUTING.md).
