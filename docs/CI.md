# CI Workflows

This repo uses GitHub Actions with built-in path filters. No third-party path-filter actions.

## CI overview

| When | What runs |
|------|-----------|
| Push to `ai/**` | auto-pr creates/updates PR |
| PR to main (code changes) | ci → check (`check` + `integration` jobs), dependency-review |
| PR to main (docs only) | ci-docs → check-docs |
| PR to main (website only) | ci-website → check-website (Astro build) |
| PR to main (.github only) | ci-workflows → `check-workflows` (actionlint, shellcheck, shfmt) |
| PR to main (nix/deps) | ci-nix → nix flake check (Linux x64 + arm64, macOS arm64) + bun.nix update |
| PR to main (release-please) | ci-release-please → check |
| Push to main | release-please, update-workflow-pins (when workflows/actions change), update-dist (when src/pkg/build/bun.lock change), scorecard (if configured) |
| PR/push (paths: `.github/workflows/**`, `scripts/act-local-ci.ts`, `flake.nix`) | [act-smoke.yml](../.github/workflows/act-smoke.yml) — matrix: **`--dry-run check`** and **`check-workflows`** in parallel (no duplicate dry-run for ci-workflows; the real act run covers that graph) |
| Manual | update-bun-nix, update-flake-lock, update-workflow-pins, update-dist |
| Weekly | update-flake-lock (Sun), scorecard (Sat), stale (Mon) |

## First-time setup

Before CI can run fully:

1. **GitHub App** — Create an app with Contents and Pull requests (Read and write). Add `APP_ID` and `APP_PRIVATE_KEY` to **Settings → Secrets and variables → Actions**. Required for auto-pr, release-please, update-dist, and add-dist-to-release-pr.
2. **Codecov** (optional) — Add `CODECOV_TOKEN` for the coverage badge and test analytics. The **`check`** job uploads unit coverage (`coverage/lcov.info`) and JUnit (`test-report.junit.xml`). The **`integration`** job does not upload to Codecov. Get the token from [codecov.io](https://codecov.io). Without it, upload steps no-op; CI still passes.
3. **Labels** — Run `./scripts/create-labels.sh` so update-flake-lock can open PRs (needs `dependencies`, `nix`, `automated`) and issue templates work (`bug`, `enhancement`, `good first issue`).
4. **Branch protection** — Require `check / check` and `check / integration` before merging to main (integration: Docker + GitHub Models smoke tests). `check / integration` is not reported by ci-workflows (`.github/**`-only PRs); do not require it for those or it will block workflow-only merges.

### Integration job and fork PRs

The **integration** job uses `GITHUB_TOKEN` with `models: read` for GitHub Models. On **fork** pull requests, token scopes or Models behavior can differ from same-repo PRs. If integration fails only on a fork, merge from a branch in this repo or re-run on `main` after merge to confirm.

### Integration tests

**Local command:** [`package.json`](../package.json) defines **`test:integration`** as:

`bun --env-file=.env.ci --env-file=.env.local --config=bunfig.integration.toml test test/integration`

- **[`.env.ci`](../.env.ci)** — committed pins (`INTEGRATION_LLAMA_PORT`, `INTEGRATION_*` URLs/model id). Same keys are injected in GitHub Actions from this file (see [integration.yml](../.github/workflows/integration.yml)).
- **`.env.local`** — optional, gitignored (matches `.env.*`). Same variable names as `.env.ci`; the second `--env-file` wins on duplicates. Omit the file if you do not need overrides (Bun does not require it to exist).

**`bun run test:integration`** runs those tests with `--no-coverage` ([`bunfig.integration.toml`](../bunfig.integration.toml); coverage is tracked on the unit job only). Local llama scenarios use Testcontainers with the image pin in `.github/llama-server/Dockerfile` (**Docker** required). Set **`INTEGRATION_SKIP_DOCKER=1`** to skip Docker-based tests. The **GitHub Models** integration test needs **`GH_TOKEN`** with **`models: read`** in your environment when running locally (for example export a PAT); in Actions the default token is sufficient.

**Dockerfile pin:** The canonical parser for the image ref is [`parseFirstFromImageDockerfileContent`](../test/integration/dockerfile-from-image.ts); CI uses the same logic in [parse-first-from-dockerfile.awk](../.github/actions/resolve-llama-server-tag/parse-first-from-dockerfile.awk), invoked by [resolve-llama-server-tag.sh](../.github/actions/resolve-llama-server-tag/resolve-llama-server-tag.sh) (`--dockerfile-image` and the repo root). [`test/integration/dockerfile-from-image.test.ts`](../test/integration/dockerfile-from-image.test.ts) keeps them aligned. Same limitations as [INTEGRATION.md](INTEGRATION.md#local-llama-dockerfile-pin) (first `FROM` only; no `\\` continuation).

**GitHub Actions (integration + generate):** Jobs that run llama in Docker use the **`llama-server-docker-start`** / **`llama-server-docker-stop`** composite actions, **`llama_server_root`**, and `docker/llama-server-image.tar` under that directory — see [INTEGRATION.md](INTEGRATION.md#local-llama-dockerfile-pin).

## Workflows

| Workflow | Trigger | Path filter | Jobs |
|----------|---------|-------------|------|
| [auto-pr.yml](../.github/workflows/auto-pr.yml) | push → `ai/**` | — | auto-pr (creates/updates PR from conventional commits) |
| [ci.yml](../.github/workflows/ci.yml) | push, pull_request → main | `paths-ignore: '**/*.md', '.github/**', 'website/**'` | check (reusable: `check` + `integration`), dependency-review |
| [ci-docs.yml](../.github/workflows/ci-docs.yml) | push, pull_request → main | `paths: '**/*.md'` | check (pass-through) |
| [ci-website.yml](../.github/workflows/ci-website.yml) | push, pull_request → main | `paths: 'website/**'` | check (reusable: [check-website.yml](../.github/workflows/check-website.yml)) |
| [ci-workflows.yml](../.github/workflows/ci-workflows.yml) | push, pull_request → main | `paths: '.github/**'` | check-workflows |
| [ci-nix.yml](../.github/workflows/ci-nix.yml) | push, pull_request → main | `paths: **/*.nix, package*.json, bun.lock, flake.lock` | nix |
| [ci-release-please.yml](../.github/workflows/ci-release-please.yml) | pull_request → main | `paths: .release-please-manifest.json` | check |
| [update-bun-nix.yml](../.github/workflows/update-bun-nix.yml) | workflow_dispatch | — | update-bun-nix (runs on default branch, pushes bun.nix to main) |
| [update-workflow-pins.yml](../.github/workflows/update-workflow-pins.yml) | push → main, workflow_dispatch | `paths: .github/workflows/**`, `.github/actions/**` | update-workflow-pins (updates self-referential pins) |
| [update-dist.yml](../.github/workflows/update-dist.yml) | push → main, workflow_dispatch | `paths: src/**`, package.json, scripts/build.ts, bun.lock | update-dist (builds and commits dist for Node-only GitHub installs) |
| [add-dist-to-release-pr.yml](../.github/workflows/add-dist-to-release-pr.yml) | pull_request → main | `paths: .release-please-manifest.json` only | add-dist (adds dist to release PR before merge so tags include it) |
| [update-flake-lock.yml](../.github/workflows/update-flake-lock.yml) | workflow_dispatch, schedule | — | update-flake-lock |
| [release-please.yml](../.github/workflows/release-please.yml) | push → main | — | release-please (creates release PRs) |
| [codeql.yml](../.github/workflows/codeql.yml) | push, pull_request → main | `paths-ignore: **/*.md, docs/**` | analyze |
| [codeql-docs.yml](../.github/workflows/codeql-docs.yml) | pull_request → main | `paths: **/*.md, docs/**` | analyze (pass-through) |
| [scorecard.yml](../.github/workflows/scorecard.yml) | push → main, schedule (Sat 01:30 UTC) | — | Scorecard analysis |
| [stale.yml](../.github/workflows/stale.yml) | schedule (Mon 00:00 UTC), workflow_dispatch | — | Mark stale issues/PRs |
| [act-smoke.yml](../.github/workflows/act-smoke.yml) | push, pull_request → main, workflow_dispatch | `paths: .github/workflows/**`, `scripts/act-local-ci.ts`, `flake.nix` | matrix: `--dry-run check` + `check-workflows` (parallel) via [`gh-act`](https://github.com/nektos/gh-act) (`GH_TOKEN` for `gh`) |
| [deploy-pages.yml](../.github/workflows/deploy-pages.yml) | push → main | `paths: docs/**`, `website/**` | build (Bun install + build in website/), deploy (GitHub Pages via actions/deploy-pages) |

**auto-pr.yml** runs on push to `ai/**` branches (including forks). Two reusable workflows: generate (unprivileged checkout + content) and create (trusted checkout + PR). The generate job uses composite actions from this repo; adopters do not vendor shell under `scripts/`. Security model: [docs/WORKFLOW_SECURITY.md](WORKFLOW_SECURITY.md). Forks need `APP_ID` and `APP_PRIVATE_KEY` in their repo secrets to succeed. See [docs/INTEGRATION.md](INTEGRATION.md).

**ci.yml** runs when any file changes outside ignored paths (`**/*.md`, `.github/**`, `website/**`). Skips when only docs, only .github, or only the Astro site under `website/` changes.

**ci-docs.yml** is complementary: runs when only `*.md` files change. Reports a passing `check` job so branch protection allows merge.

**ci-website.yml** is complementary: triggers on `website/**` changes and runs an Astro production build (same idea as [deploy-pages.yml](../.github/workflows/deploy-pages.yml)). Does not run unit tests, integration tests, or act-smoke. If a PR also changes non-ignored paths, **`ci.yml` runs too** (mixed PR): you get both workflows; only **check-website** runs the Astro build.

**ci-workflows.yml** is complementary: runs when only `.github/**` changes. Runs **check-workflows** (actionlint, shellcheck, shfmt on `.github/actions`). Integration tests do not run for workflow-only changes — they test AI provider HTTP behavior, which is unaffected by workflow YAML.

**ci-nix.yml** runs only when Nix or dependency files change. Uses upstream Nix ([cachix/install-nix-action](https://github.com/cachix/install-nix-action)), runs statix and deadnix via `nix flake check`, and auto-updates `bun.nix` for same-repo PRs and main. Uses the same GitHub App as auto-pr for the push so CI triggers on the new commit (GITHUB_TOKEN pushes do not trigger workflows).

**update-bun-nix.yml** runs on manual trigger (workflow_dispatch). Use when `main` has a stale `bun.nix` (e.g. after merging a lockfile change from a fork). Runs on the default branch and pushes the updated `bun.nix` to `main`. For same-repo PRs, ci-nix handles updates automatically.

**update-workflow-pins.yml** runs on push to main when workflows or actions change, and on workflow_dispatch. Updates self-referential `knirski/auto-pr/...@SHA` refs to the current commit. Loop prevention: skips when the push commit message starts with `chore(workflows): update self-referential pins`. Only runs in knirski/auto-pr (skips forks). See [.github/actions/update-workflow-pins/README.md](../.github/actions/update-workflow-pins/README.md).

**update-dist.yml** runs on push to main when `src/`, `package.json`, `scripts/build.ts`, or `bun.lock` change, and on workflow_dispatch. Uses [build-and-commit-dist](../.github/actions/build-and-commit-dist) to build and commit `dist/` so `npx -p github:knirski/auto-pr` works for Node-only users (no Bun). `dist/` is in `.gitignore` locally—the action uses `git add -f dist/` to override. Loop prevention: skips when commit message starts with `chore: update dist`. Only runs in knirski/auto-pr. See [Dist and .gitignore](#dist-and-gitignore).

**add-dist-to-release-pr.yml** runs when `.release-please-manifest.json` changes on a PR to main (release-please updates that file; ordinary PRs that only change `package.json` or `CHANGELOG.md` do not trigger this). Uses build-and-commit-dist to add `dist/` to the PR branch so the merge commit—and thus the release tag—includes it. Fixes `npx -p github:knirski/auto-pr#v0.1.2` for Node-only users.

**update-flake-lock.yml** runs weekly (Sunday 00:00 UTC) and on manual trigger. Updates `flake.lock` and opens a PR. Requires `dependencies`, `nix`, and `automated` labels. Run `./scripts/create-labels.sh` before the first scheduled run.

**release-please.yml** runs on push to main. Creates release PRs from conventional commits; updates version and CHANGELOG. Requires `APP_ID` and `APP_PRIVATE_KEY` secrets.

**codeql.yml** runs when non-docs code changes. Uses security-extended queries for actions and javascript-typescript. Skips for docs-only changes.

**codeql-docs.yml** is complementary to codeql.yml: runs when only docs change. CodeQL skips for docs (paths-ignore); this reports passing status so code scanning allows merge.

**scorecard.yml** runs on push to main and weekly (Saturday 01:30 UTC). Publishes OpenSSF Scorecard results to code scanning.

**stale.yml** runs weekly (Monday 00:00 UTC) and on manual trigger. Marks issues/PRs stale after 180 days, closes after 180 more. Exempts `pinned` and `security` labels.

## Run CI locally

`bun run act` runs two jobs via [act](https://github.com/nektos/act) in Docker: first **`check`** from [ci.yml](../.github/workflows/ci.yml) (reusable [check.yml](../.github/workflows/check.yml): tests, lint, Codecov, etc.), then **`integration`** from [integration.yml](../.github/workflows/integration.yml) (Testcontainers llama + GitHub Models HTTP tests). Requires Docker and either `act` on your PATH, Nix on **Linux** (x86_64/aarch64) where this flake provides `act` (`nix run .#act` when `act` is not on PATH), or `gh extension install nektos/gh-act` for `gh act`. [act-local-ci.ts](../scripts/act-local-ci.ts) passes **`-P <runs-on>=<container image>`** (default label **`ubuntu-24.04`**, overridable with **`ACT_RUNS_ON_LABEL`**; image from **`ACT_RUNNER_IMAGE`** or defaults — see [CONTRIBUTING.md](../CONTRIBUTING.md#run-ci-locally-check-job)), writes a minimal **workflow_dispatch** JSON to `.act-artifacts/workflow_dispatch.json` (owner/name from **`git remote origin`** or **`package.json` `repository`**) for **`act -e`**, and starts act’s **artifact server** under `.act-artifacts/` (gitignored). Integration is heavier than `check` alone.

**More workflows:** `bun run act -- check-workflows` runs only [ci-workflows.yml](../.github/workflows/ci-workflows.yml) (reusable [check-workflows.yml](../.github/workflows/check-workflows.yml): actionlint + shellcheck on `.github`). Use it when editing workflows or actions—much faster than the full `check` job.

**Dry runs:** `bun run act -- --dry-run check` and `bun run act -- --dry-run check-workflows` pass **`act --dryrun`** ([nektos/act](https://github.com/nektos/act) validates workflow graphs without a full run). Useful before a long `check` act run or to catch YAML/reusable-workflow issues early. Still uses Docker for parts of planning; not a substitute for **`bun run check`** or hosted CI.

**Act on GitHub:** [act-smoke.yml](../.github/workflows/act-smoke.yml) runs on pushes/PRs that touch act-related paths (`.github/workflows`, `scripts/act-local-ci.ts`, `flake.nix`, etc.). It uses a **strategy matrix** so **`--dry-run check`** (**ci.yml** graph) and **`check-workflows`** run **in parallel** on separate runners (each installs [**nektos/gh-act**](https://github.com/nektos/gh-act) and runs [act-local-ci.ts](../scripts/act-local-ci.ts); **`GH_TOKEN`** = **`github.token`** for [GitHub CLI in Actions](https://docs.github.com/en/actions/using-workflows/using-github-cli-in-workflows)). There is no **`--dry-run check-workflows`** because the matrix **`check-workflows`** cell covers that graph. **`gh act`** is used when `act` is not on `PATH`; a **smaller default container image** applies for both cells unless **`ACT_RUNNER_IMAGE`** is set. It does **not** run full **`check`** in act (too slow), **`integration`**, or **`dependency-review`** (GitHub-only). It does **not** replace hosted `check` or prove full parity with `bun run act`.

**What we do not run in act-smoke:** Full **`ci.yml` `check`** in act (long, duplicates hosted CI), **`integration.yml`** (heavy, secrets/models), **`ci-docs`** / **`check-docs`**, **`ci-website`** / **`check-website`** (thin wrappers), and **`dependency-review`** (needs GitHub APIs). Use **`bun run check`** and hosted Actions for those.

Pre-push runs `check:code` before each push (Bun deps only). See [CONTRIBUTING.md](../CONTRIBUTING.md#pre-push-hook).

## Link verification

`bun run check:just-links` runs lychee to verify links in the repo. Can fail on broken external URLs (404s, redirects). Use `check:with-links` to run full check plus link verification. Both check.yml and check-docs.yml run lychee with `continue-on-error: true` so link failures do not block merge. Lychee accepts 200 and 429 (rate limit) via `--accept 200,429`.

## Secret scan and shell lint paths

[check.yml](../.github/workflows/check.yml) and [check-workflows.yml](../.github/workflows/check-workflows.yml) skip dependency and build output trees for **gitleaks** and **[luizm/action-sh-checker](https://github.com/luizm/action-sh-checker)** (shellcheck + shfmt). After `bun install`, `shfmt -f .` would otherwise discover shell scripts under `node_modules`; `sh_checker_exclude` filters those paths. Gitleaks uses the same intent via [.gitleaks.toml](../.gitleaks.toml) allowlist paths and [.gitleaksignore](../.gitleaksignore) (`node_modules/`, `dist/`, `coverage/`, `.worktrees/`). Typos ([_typos.toml](../_typos.toml)) also extends excludes for those directories.

## Branch Protection

Configure main branch protection to require:

- **`check / check`** — from [ci.yml](../.github/workflows/ci.yml), [ci-release-please.yml](../.github/workflows/ci-release-please.yml), [ci-docs.yml](../.github/workflows/ci-docs.yml) (pass-through), [ci-website.yml](../.github/workflows/ci-website.yml) (pass-through), and [ci-workflows.yml](../.github/workflows/ci-workflows.yml) (via [check-workflows.yml](../.github/workflows/check-workflows.yml)).
- **`check / integration`** — from [ci.yml](../.github/workflows/ci.yml) and [ci-release-please.yml](../.github/workflows/ci-release-please.yml). Not reported by ci-docs, ci-website, or ci-workflows (docs/website/workflow-only paths do not run integration).

Do not require `dependency-review` (PR-only), `nix` (path-filtered), or `act-smoke` (path-filtered smoke test); they would block when skipped or unrelated paths change.

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

Self-referential pins (`knirski/auto-pr/...@SHA`) are updated automatically by [update-workflow-pins.yml](../.github/workflows/update-workflow-pins.yml) on push to main when workflows or actions change. Manual run: **Actions → Update workflow pins → Run workflow**. Rationale: [ADR 0004](adr/0004-workflow-pin-automation.md).

**When automation runs:** Push to main with changes under `.github/workflows/` or `.github/actions/`. The workflow updates all pins to the current commit and pushes. Loop prevention: it skips when the push came from itself (commit message starts with `chore(workflows): update self-referential pins`).

**Manual update (if needed):** If automation didn't run (e.g. merge only touched `src/`), run the workflow manually or update pins yourself. See [.github/actions/update-workflow-pins/README.md](../.github/actions/update-workflow-pins/README.md).

## Dist and .gitignore

`dist/` is in `.gitignore` so **untracked** files under `dist/` are not listed by Git and are not added unless you `git add -f`. **Tracked** `dist/` (as on `main` after CI) still shows as modified after a local build—do not commit it; the pre-commit hook ([check-no-dist-staged.sh](../scripts/check-no-dist-staged.sh)) rejects staging `dist/`. The [update-dist.yml](../.github/workflows/update-dist.yml) workflow (via [build-and-commit-dist](../.github/actions/build-and-commit-dist)) builds `dist/` in CI and commits it using `git add -f dist/`—the `-f` flag overrides `.gitignore`. This allows:

- **Local dev:** `dist/` is gitignored. If you branch from main (after update-dist has run), `dist/` may be tracked; running `bun run build` then shows `modified: dist/` in status—do not commit it, the workflow updates main after merge.
- **Contributors testing on knirski/auto-pr:** When the workflow runs in knirski/auto-pr (e.g. on ai/** branches), it uses the workspace source (`bun run`) instead of the npx package. That avoids requiring committed `dist/` on the branch and prevents "Package does not provide binary" when testing changes before merge.
- **Node-only GitHub installs:** `npx -p github:knirski/auto-pr auto-pr-init` works without Bun because `dist/` is committed by CI.
- **`prepare` script:** Runs `bun run build`; if Bun is unavailable, no-ops (`|| exit 0`). Works for Node-only (npm) and Bun-only (bun) installs; Node-only use the committed `dist/` from the repo.

**Do not remove `-f`** from `git add -f dist/` in the action; without it, ignored files would not be staged.

**Version tags:** [add-dist-to-release-pr.yml](../.github/workflows/add-dist-to-release-pr.yml) adds `dist/` to release-please PRs before merge, so tagged commits (e.g. `npx -p github:knirski/auto-pr#v0.1.2`) include it. **Before merging a release PR**, wait for "Add dist to release PR" to complete so the tagged commit includes `dist/`.
