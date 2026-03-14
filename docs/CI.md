# CI Workflows

This repo uses GitHub Actions with built-in path filters. No third-party path-filter actions.

## First-time setup

Before CI can run fully:

1. **GitHub App** — Create an app with Contents and Pull requests (Read and write). Add `APP_ID` and `APP_PRIVATE_KEY` to **Settings → Secrets and variables → Actions**. Required for auto-pr and release-please.
2. **Labels** — Run `./scripts/create-labels.sh` so update-flake-lock can open PRs (needs `dependencies`, `nix`, `automated`).
3. **Branch protection** — Require `check / check` before merging to main.

## Workflows

| Workflow | Trigger | Path filter | Jobs |
|----------|---------|-------------|------|
| [auto-pr.yml](../.github/workflows/auto-pr.yml) | push → `ai/**` | — | auto-pr (creates/updates PR from conventional commits) |
| [ci.yml](../.github/workflows/ci.yml) | push, pull_request → main | `paths-ignore: '**/*.md'` | check, dependency-review |
| [ci-docs.yml](../.github/workflows/ci-docs.yml) | push, pull_request → main | `paths: '**/*.md'` | check (pass-through) |
| [ci-nix.yml](../.github/workflows/ci-nix.yml) | push, pull_request → main | `paths: **/*.nix, package*.json, flake.lock` | nix |
| [ci-release-please.yml](../.github/workflows/ci-release-please.yml) | pull_request → main | `paths: .release-please-manifest.json` | check |
| [update-nix-hash.yml](../.github/workflows/update-nix-hash.yml) | workflow_dispatch | — | update-hash |
| [update-flake-lock.yml](../.github/workflows/update-flake-lock.yml) | workflow_dispatch, schedule | — | update-flake-lock |

**auto-pr.yml** runs on push to `ai/**` branches (non-forks). Creates or updates a PR with title and body from conventional commits; Ollama generates description for 2+ commits. See [docs/INTEGRATION.md](INTEGRATION.md).

**ci.yml** runs when any non-.md file changes. Skips when only docs change.

**ci-docs.yml** is complementary: runs when only `*.md` files change. Reports a passing `check` job so branch protection allows merge.

**ci-nix.yml** runs only when Nix or dependency files change. Runs Nix build and auto-updates `npmDepsHash` in `default.nix` for same-repo PRs and main. Uses the same GitHub App as auto-pr for the push so CI triggers on the new commit (GITHUB_TOKEN pushes do not trigger workflows).

**update-flake-lock.yml** runs weekly (Sunday 00:00 UTC) and on manual trigger. Updates `flake.lock` and opens a PR. Requires `dependencies`, `nix`, and `automated` labels. Run `./scripts/create-labels.sh` before the first scheduled run.

## Branch Protection

Both ci.yml and ci-docs.yml report **`check / check`**. Configure main branch protection to require:

- **Status checks that are required:** `check / check`

Do not require `dependency-review` (PR-only) or `nix` (path-filtered); they would block when skipped.

## Fork PRs

CI cannot push to forks. If the nix job fails (ci-nix.yml), update locally: `nix run .#update-npm-deps-hash` (or `npm run update-nix-hash -- <hash>` using the hash from the failed job), then commit and push. See [CONTRIBUTING.md](../CONTRIBUTING.md).
