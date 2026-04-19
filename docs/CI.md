# CI Workflows

This repo uses GitHub Actions. The main [ci.yml](../.github/workflows/ci.yml) entry uses [dorny/paths-filter](https://github.com/dorny/paths-filter) to decide which jobs run.

## CI overview

| When | What runs |
|------|-----------|
| Push to `ai/**` | auto-pr creates/updates PR |
| PR to main (any paths) | [ci.yml](../.github/workflows/ci.yml) runs always; path filters fan out to `check`, `integration`, `docs-lint`, `website`, `workflows-lint`, `nix`, `dependency-review` (PRs), and **`gate`**. |
| PR to main (code changes) | `ci.yml`: `check` → [check.yml](../.github/workflows/check.yml) + `integration` → [integration.yml](../.github/workflows/integration.yml) + `dependency-review` when paths match `code` |
| PR to main (docs only) | `ci.yml`: `docs-lint` → [check-docs.yml](../.github/workflows/check-docs.yml) |
| PR to main (website only) | `ci.yml`: `website` → [check-website.yml](../.github/workflows/check-website.yml) |
| PR to main (.github only) | `ci.yml`: `workflows-lint` → [check-workflows.yml](../.github/workflows/check-workflows.yml) |
| PR to main (nix/deps) | `ci.yml`: `nix` → [nix.yml](../.github/workflows/nix.yml) |
| PR to main (release-please) | `ci.yml`: `check` → [check.yml](../.github/workflows/check.yml) when `release_manifest` or `code` matches |
| Push to main | release-please, update-workflow-pins (when workflows/actions change), update-dist (when src/pkg/build/bun.lock change), scorecard (if configured) |
| PR/push (paths: `.github/workflows/**`, `scripts/act-local-ci.ts`, `flake.nix`) | [act-smoke.yml](../.github/workflows/act-smoke.yml) — matrix: **`--dry-run check`** and **`check-workflows`** in parallel (the second cell runs **`ci.yml`** job **`workflows-lint`**) |
| Manual | update-bun-nix, update-flake-lock, update-workflow-pins, update-dist |
| Weekly | update-flake-lock (Sun), scorecard (Sat), stale (Mon) |

## First-time setup

Before CI can run fully:

1. **GitHub App** — Create an app with Contents and Pull requests (Read and write). Add `APP_ID` and `APP_PRIVATE_KEY` to **Settings → Secrets and variables → Actions**. Required for auto-pr, release-please, update-dist, and add-dist-to-release-pr.
2. **Codecov** (optional) — Add `CODECOV_TOKEN` for the coverage badge and test analytics. The **`check`** job uploads unit coverage (`coverage/lcov.info`) and JUnit (`test-report.junit.xml`). The **`integration`** job does not upload to Codecov. Get the token from [codecov.io](https://codecov.io). Without it, upload steps no-op; CI still passes.
3. **Labels** — Run `./scripts/create-labels.sh` so update-flake-lock can open PRs (needs `dependencies`, `nix`, `automated`) and issue templates work (`bug`, `enhancement`, `good first issue`).
4. **Branch protection** — Require **`CI / gate`** (see [Branch Protection](#branch-protection)). Integration covers Docker + GitHub Models smoke tests.

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
| [ci.yml](../.github/workflows/ci.yml) | push, pull_request → main, workflow_dispatch | — (path filtering inside job `changes` via dorny/paths-filter) | `changes`, `dependency-review`, `check`, `integration`, `docs-lint`, `website`, `workflows-lint`, `nix`, `gate` |
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

**ci.yml** is the single entry for push/PR to `main`: the `changes` job applies path filters so each downstream job runs only when relevant. The **`gate`** job aggregates outcomes for branch protection as **`CI / gate`**. The **`nix`** job calls [nix.yml](../.github/workflows/nix.yml): upstream Nix ([cachix/install-nix-action](https://github.com/cachix/install-nix-action)), statix/deadnix via `nix flake check`, and auto-updates `bun.nix` for same-repo PRs and `main` using the same GitHub App as auto-pr when a push is needed (GITHUB_TOKEN pushes do not trigger workflows).

Separately, [update-flake-lock.yml](../.github/workflows/update-flake-lock.yml) runs [DeterminateSystems/update-flake-lock](https://github.com/DeterminateSystems/update-flake-lock) — a **single-purpose lockfile-refresh utility**, not a Nix installer. That workflow still installs upstream Nix via the [`setup-nix-with-cache`](../.github/actions/setup-nix-with-cache/action.yml) composite before running the refresh action. Using the Determinate *action* does not reopen [ADR 0006](adr/0006-nix-ci-upstream-and-caching.md)'s choice of Determinate's *installer*.

**update-bun-nix.yml** runs on manual trigger (workflow_dispatch). Use when `main` has a stale `bun.nix` (e.g. after merging a lockfile change from a fork). Runs on the default branch and pushes the updated `bun.nix` to `main`. For same-repo PRs, the **`nix`** job in `ci.yml` handles updates automatically when paths match.

**update-workflow-pins.yml** runs on push to main when workflows or actions change, and on workflow_dispatch. Updates **only** self-referential `knirski/auto-pr/...@SHA` refs to the push commit (not marketplace actions or Dockerfiles). Loop prevention: skips when the push commit message starts with `chore(workflows): update self-referential pins` and `github.event.head_commit.author.name` is `github-actions[bot]`. The **Commit-and-push** step sets `git config user.name` / `user.email` to that identity before `git commit`; the **push** uses a GitHub App token (so the new commit triggers workflows—`GITHUB_TOKEN` alone would not), but the git author metadata is still `github-actions[bot]`, not the App’s slug. Do not use `github.actor` for this check: on the triggered run it reflects the App, while `head_commit.author.name` comes from the commit object. Only runs in knirski/auto-pr (skips forks). **check** and **check-workflows** validate pins with `check_only: true`. Full matrix and contributor steps: [Workflow pin automation](#workflow-pin-automation); action reference: [.github/actions/update-workflow-pins/README.md](../.github/actions/update-workflow-pins/README.md).

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

**Docker parity:** [check.yml](../.github/workflows/check.yml) sets **`RUNNER_TOOL_CACHE`** / **`AGENT_TOOLSDIRECTORY`** under the workspace so **`actions/setup-node`** (SBOM step) avoids **`EACCES`** on `/opt/hostedtoolcache` in act. [act-local-ci.ts](../scripts/act-local-ci.ts) leaves **`--artifact-server-port`** at act’s default unless you set **`ACT_ARTIFACT_SERVER_PORT`** / **`ACT_ARTIFACT_SERVER_ADDR`** (**`0`** is not a safe default—artifact uploads can fail). Details: [CONTRIBUTING.md](../CONTRIBUTING.md#run-ci-locally-check-job).

**Integration + nested Docker:** On Linux, [act-local-ci.ts](../scripts/act-local-ci.ts) passes **`act --container-options`** with **`--group-add`** set from the host **`/var/run/docker.sock`** group id when that path exists, so integration jobs can run **`docker`** inside the act job container. Override with **`ACT_CONTAINER_OPTIONS`** or disable auto with **`ACT_SKIP_AUTO_DOCKER_GROUP_ADD=1`**. Rootless Docker or a nonstandard socket may need manual **`ACT_CONTAINER_OPTIONS`**. [integration.yml](../.github/workflows/integration.yml) caches llama artifacts under **`github.workspace/.cache/`** (stable vs **`runner.temp`** when debugging paths). The **llama-server-docker-start** action copies the GGUF into the container with **`docker cp`**, not a bind mount, so nested Docker (act) does not rely on host path alignment. Parallel llama jobs each bind an **ephemeral TCP port** on the runner (inline **`python3`** one-liner in [integration.yml](../.github/workflows/integration.yml), as on GitHub-hosted Ubuntu) and use distinct **`container_name`** values so they do not collide on a single Docker daemon. Only when simulating **`integration.yml`** (not **`check`** / **`check-workflows`**) does [act-local-ci.ts](../scripts/act-local-ci.ts) pass **`--env AUTO_PR_ACT_LOCAL_CI=1`** so the happy-path integration test can use a longer timeout under CPU-bound [nektos/act](https://github.com/nektos/act).

**GitHub Models job:** The **`integration-github-models`** job loads **`.env.ci`** with **`omit_llama_integration_env: true`** so llama-related keys and **`AUTO_PR_AI_OPENAI_COMPAT_URL`** from **`.env.ci`** are not applied (that job uses GitHub Models only).

**More workflows:** `bun run act -- check-workflows` runs the **`workflows-lint`** job from [ci.yml](../.github/workflows/ci.yml) (reusable [check-workflows.yml](../.github/workflows/check-workflows.yml): actionlint + shellcheck on `.github`). Use it when editing workflows or actions—much faster than the full `check` job.

**Dry runs:** `bun run act -- --dry-run check` and `bun run act -- --dry-run check-workflows` pass **`act --dryrun`** ([nektos/act](https://github.com/nektos/act) validates workflow graphs without a full run). Useful before a long `check` act run or to catch YAML/reusable-workflow issues early. Still uses Docker for parts of planning; not a substitute for **`bun run check`** or hosted CI.

**Act on GitHub:** [act-smoke.yml](../.github/workflows/act-smoke.yml) runs on pushes/PRs that touch act-related paths (`.github/workflows`, `scripts/act-local-ci.ts`, `flake.nix`, etc.). It uses a **strategy matrix** so **`--dry-run check`** (**ci.yml** graph) and **`check-workflows`** run **in parallel** on separate runners (each installs [**nektos/gh-act**](https://github.com/nektos/gh-act) and runs [act-local-ci.ts](../scripts/act-local-ci.ts); **`GH_TOKEN`** = **`github.token`** for [GitHub CLI in Actions](https://docs.github.com/en/actions/using-workflows/using-github-cli-in-workflows)). There is no **`--dry-run check-workflows`** because the matrix **`check-workflows`** cell covers that graph. **`gh act`** is used when `act` is not on `PATH`; a **smaller default container image** applies for both cells unless **`ACT_RUNNER_IMAGE`** is set. It does **not** run full **`check`** in act (too slow), **`integration`**, or **`dependency-review`** (GitHub-only). It does **not** replace hosted `check` or prove full parity with `bun run act`.

**What we do not run in act-smoke:** Full **`ci.yml` `check`** in act (long, duplicates hosted CI), **`integration.yml`** (heavy, secrets/models), **`docs-lint`** / **`check-docs`**, **`website`** / **`check-website`** (domain-specific), and **`dependency-review`** (needs GitHub APIs). Use **`bun run check`** and hosted Actions for those.

Pre-push runs `check:code` before each push (Bun deps only). See [CONTRIBUTING.md](../CONTRIBUTING.md#pre-push-hook).

## Link verification

`bun run check:just-links` runs lychee to verify links in the repo. Can fail on broken external URLs (404s, redirects). Use `check:with-links` to run full check plus link verification. Both check.yml and check-docs.yml run lychee with `continue-on-error: true` so link failures do not block merge. Lychee accepts 200 and 429 (rate limit) via `--accept 200,429`.

## Secret scan and shell lint paths

[check.yml](../.github/workflows/check.yml) and [check-workflows.yml](../.github/workflows/check-workflows.yml) skip dependency and build output trees for **gitleaks** and **[luizm/action-sh-checker](https://github.com/luizm/action-sh-checker)** (shellcheck + shfmt). After `bun install`, `shfmt -f .` would otherwise discover shell scripts under `node_modules`; `sh_checker_exclude` filters those paths. Gitleaks uses the same intent via [.gitleaks.toml](../.gitleaks.toml) allowlist paths and [.gitleaksignore](../.gitleaksignore) (`node_modules/`, `dist/`, `coverage/`, `.worktrees/`). Typos ([_typos.toml](../_typos.toml)) also extends excludes for those directories.

## Branch Protection

Configure main branch protection to require **a single status check**:

- **`CI / gate`** — reported by [ci.yml](../.github/workflows/ci.yml)'s `gate` job. The gate is `needs: [dependency-review, check, integration, docs-lint, website, workflows-lint, nix]` with `if: always()`, and fails only if any needed job's `result` is not `success` or `skipped`. A docs-only PR's `check` / `integration` / `website` / `workflows-lint` / `nix` jobs skip; `docs-lint` runs; `gate` evaluates success-or-skipped across all seven → passes. Same idea for every other path category.

Do NOT require individual job names (`check / check`, `dependency-review`, etc.) directly — they path-filter correctly inside `ci.yml` and are reported as skipped for unrelated changes, which would otherwise block branch protection.

## Dependency review and vulnerability detection

**dependency-review** runs on PRs (except Dependabot Bun PRs). For Dependabot Bun PRs, the job is skipped because GitHub's dependency graph may not yet support `bun.lock`. Vulnerability detection is covered by **bun audit** in the check job (`bun audit --audit-level=high` runs on every PR, including Dependabot Bun PRs).

**License checking:** dependency-review can flag license changes when it runs. When it is skipped (Dependabot Bun PRs), license changes are not automatically checked. To audit licenses manually or in CI, consider tools like `license-checker` or `manypkg check licenses`; add to the check workflow if desired.

## Troubleshooting: "CI / gate" waiting for status

When the **`nix`** job pushes a `bun.nix` update, the PR head changes to a new commit. **`CI / gate`** must run on that new commit. If you see "waiting for status to be reported":

1. **Wait 1–2 minutes** — The push triggers the check workflow; it may take a moment to start.
2. **Re-run workflows** — If the check still hasn't run, use "Re-run all jobs" from the Actions tab.
3. **Manual trigger** — Push an empty commit: `git commit --allow-empty -m "ci: trigger workflows" && git push`.

## Fork PRs

CI cannot push to forks. If the **`nix`** job fails, update locally: `nix run .#update-bun-nix`, then commit and push. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Workflow pin automation

This repo pins workflow dependencies immutably where GitHub allows it: **full commit SHAs** for actions, **one shared SHA** for every self-referential `knirski/auto-pr/...@…` line, and **image digests or tags** for the llama CI Dockerfile. Rationale for the self-ref updater: [ADR 0004](adr/0004-workflow-pin-automation.md).

### What is pinned how

| Kind | Example | Update path |
|------|---------|-------------|
| Marketplace / third-party actions | `uses: actions/checkout@<40-char-sha> # v6.0.2` | Weekly [Dependabot](../.github/dependabot.yml) (`package-ecosystem: github-actions`); merge its PRs or bump SHA + comment by hand after verifying the release |
| Self-referential callables | `uses: knirski/auto-pr/.github/actions/foo@<40-char-sha>` | [update-workflow-pins.yml](../.github/workflows/update-workflow-pins.yml) on push to `main` when `.github/workflows/**` or `.github/actions/**` change; validation in every **`check`** and **`check-workflows`** run ([`check_only`](../.github/actions/update-workflow-pins/README.md)) |
| Same-repo callables (no external fetch) | `uses: ./.github/workflows/check.yml` or `./.github/actions/name` | No extra SHA: GitHub uses the workflow’s checked-out ref |
| Llama server base image | `FROM …` in [`.github/llama-server/Dockerfile`](../.github/llama-server/Dockerfile) | Dependabot `docker` on `/.github/llama-server`; keep parser parity with [dockerfile-from-image tests](../test/integration/dockerfile-from-image.test.ts) |

The [update-workflow-pins](../.github/actions/update-workflow-pins/update-pins.sh) script only rewrites lines matching `knirski/auto-pr/<path>@<40-char-sha>`. It does **not** bump third-party actions or Dockerfiles.

### Self-referential pins (knirski/auto-pr → knirski/auto-pr)

All matching `uses:` lines must share **exactly one** 40-character SHA. That commit must exist in the clone, be an **ancestor of `HEAD`** for the workflow run, and contain **every** referenced `.github/...` path at that commit (so you cannot point at an older tree that lacks a composite you call). Tags and branch names are not valid for these refs—the regex and CI expect a full SHA. See [Why this automation cannot be deleted](#why-this-automation-cannot-be-deleted) for which workflow files must carry these pins.

**On `main` after merge:** [update-workflow-pins.yml](../.github/workflows/update-workflow-pins.yml) sets every self-ref to the push commit and pushes. Loop prevention: skip when the commit message starts with `chore(workflows): update self-referential pins` **and** `github.event.head_commit.author.name` is `github-actions[bot]`. That name is set explicitly in the workflow via `git config` before `git commit`; it is independent of which credential pushes (App token vs default token). A human reusing the prefix still runs the updater. **Manual run:** Actions → **Update workflow pins** → Run workflow (e.g. if only `src/` changed but pins should still advance—rare).

**On a PR branch:** CI runs the same checks as `check_only`; align pins before push. From repo root after your changes are committed, you can run the composite in write mode with `target_sha: $(git rev-parse HEAD)` (see **Same-repo contributors** under [Pull Requests](../CONTRIBUTING.md#pull-requests)) or run `update-pins.sh` with `INPUT_CHECK_ONLY=false` and `INPUT_TARGET_SHA` set. [Lefthook](../lefthook.yml) runs [smoke-update-pins-check-only.sh](../scripts/smoke-update-pins-check-only.sh) when you stage workflow/action YAML.

**Forks:** The update workflow runs only when `github.repository == 'knirski/auto-pr'`. Fork maintainers must keep self-refs consistent themselves if they run these workflows.

### Why this automation cannot be deleted

Three files contain self-referential `knirski/auto-pr/…@<SHA>` refs that **cannot** be converted to `./`. Each entry explains the constraint:

| File | Why `./` won't work |
|------|--------------------|
| [auto-pr.yml](../.github/workflows/auto-pr.yml) | Distributed verbatim into adopter repos by `npx auto-pr-init`. When it runs in an adopter's repo, `./` resolves to the adopter's checkout — which does not contain `auto-pr-generate-reusable.yml` or `auto-pr-create-reusable.yml`. The full `knirski/auto-pr/…@<SHA>` ref points GitHub at this repo explicitly. |
| [auto-pr-generate-reusable.yml](../.github/workflows/auto-pr-generate-reusable.yml) | Externally called via `workflow_call` from `auto-pr.yml` in adopter repos. The adopter's runner performs the checkout; `./` resolves against the adopter's tree. Every composite-action `uses:` inside this file must pin `knirski/auto-pr/.github/actions/…@<SHA>` for the same reason. |
| [auto-pr-create-reusable.yml](../.github/workflows/auto-pr-create-reusable.yml) | Same as above. |

Concretely: these three files have no way to reach `.github/actions/*` in *this* repo except by SHA-pinned full path. Any internal-only workflow (`check.yml`, `integration.yml`, `check-workflows.yml`, etc.) can and should use `./`. The post-merge pin-updater (`update-workflow-pins.yml`) exists solely to keep the three load-bearing files' pins advancing after each merge to `main`; it is not discretionary.

Rationale and history: [ADR 0004 — workflow-pin automation](adr/0004-workflow-pin-automation.md).

### Third-party actions

Prefer **SHA + human-readable comment** (`# vX.Y.Z`) so reviewers see intent. After a Dependabot bump, spot-check release notes; resolve conflicts like any other dependency PR.

### Related docs

- [.github/actions/update-workflow-pins/README.md](../.github/actions/update-workflow-pins/README.md) — inputs, local `check_only`, pre-commit hook
- [CONTRIBUTING.md](../CONTRIBUTING.md#pull-requests) — same-repo workflow pin commands (under Pull Requests)
- [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md) — stale SHA / missing path errors

## Dist and .gitignore

`dist/` is in `.gitignore` so **untracked** files under `dist/` are not listed by Git and are not added unless you `git add -f`. **Tracked** `dist/` (as on `main` after CI) still shows as modified after a local build—do not commit it; the pre-commit hook ([check-no-dist-staged.sh](../scripts/check-no-dist-staged.sh)) rejects staging `dist/`. The [update-dist.yml](../.github/workflows/update-dist.yml) workflow (via [build-and-commit-dist](../.github/actions/build-and-commit-dist)) builds `dist/` in CI and commits it using `git add -f dist/`—the `-f` flag overrides `.gitignore`. This allows:

- **Local dev:** `dist/` is gitignored. If you branch from main (after update-dist has run), `dist/` may be tracked; running `bun run build` then shows `modified: dist/` in status—do not commit it, the workflow updates main after merge.
- **Contributors testing on knirski/auto-pr:** When the workflow runs in knirski/auto-pr (e.g. on ai/** branches), it uses the workspace source (`bun run`) instead of the npx package. That avoids requiring committed `dist/` on the branch and prevents "Package does not provide binary" when testing changes before merge.
- **Node-only GitHub installs:** `npx -p github:knirski/auto-pr auto-pr-init` works without Bun because `dist/` is committed by CI.
- **`prepare` script:** Runs `bun run build`; if Bun is unavailable, no-ops (`|| exit 0`). Works for Node-only (npm) and Bun-only (bun) installs; Node-only use the committed `dist/` from the repo.

**Do not remove `-f`** from `git add -f dist/` in the action; without it, ignored files would not be staged.

**Version tags:** [add-dist-to-release-pr.yml](../.github/workflows/add-dist-to-release-pr.yml) adds `dist/` to release-please PRs before merge, so tagged commits (e.g. `npx -p github:knirski/auto-pr#v0.1.2`) include it. **Before merging a release PR**, wait for "Add dist to release PR" to complete so the tagged commit includes `dist/`.
