# Integration Guide

This guide walks through adding auto-pr to any repository so that pushes to `ai/**` branches automatically create or update pull requests.

**Typical setup:** GitHub Actions only — `auto-pr-init`, GitHub App, secrets, then push to `ai/**`. No `package.json` or install of auto-pr in your repo; reusable workflows pull from `knirski/auto-pr`. **Optional:** install or `npx -p github:knirski/auto-pr …` to run CLIs locally — [Step 1 (optional)](#step-1-optional-install-the-package-for-local-cli).

## Getting started

1. **Run** `npx -p github:knirski/auto-pr auto-pr-init` in your repo — creates the workflow, PR template, `.nvmrc`, and `.github/llama-server/Dockerfile` (llama-server image pin when using local Docker llama)
2. **Create** a [GitHub App](https://github.com/settings/apps/new) with Contents and Pull requests (Read and write)
3. **Generate** a private key in the app settings and save the `.pem` file
4. **Install** the app on your repository
5. **Add** `APP_ID` and `APP_PRIVATE_KEY` to **Settings → Secrets and variables → Actions**
6. **Test** — push to an `ai/**` branch: `git checkout -b ai/test && git commit --allow-empty -m "chore: test" && git push -u origin HEAD`

No `package.json` required. Works with any project (Node, Python, Rust, etc.). No Nix required.

## Repository setup checklist

| Requirement | How to set up |
|-------------|---------------|
| **Workflow + template** | Run `npx -p github:knirski/auto-pr auto-pr-init` in your repo. Creates `.github/workflows/auto-pr.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, `.nvmrc`, and `.github/llama-server/Dockerfile`. [Step 6](#step-6-add-the-workflow-file) |
| **GitHub App** | Create at [github.com/settings/apps/new](https://github.com/settings/apps/new). Permissions: Contents, Pull requests (Read and write). [Step 2](#step-2-create-the-github-app) |
| **Private key** | Generate in the app settings → Private keys. Save the `.pem` file. [Step 3](#step-3-generate-and-save-the-private-key) |
| **App installed** | Install the app on your repository (Install App → select repo). [Step 4](#step-4-install-the-app-on-your-repo) |
| **Secrets** | Add `APP_ID` and `APP_PRIVATE_KEY` to **Settings → Secrets and variables → Actions** (optional: `GH_TOKEN` to override the default token for GitHub Models). [Step 5](#step-5-add-repository-secrets) |
| **Branch protection** | (Optional) Require `Auto-PR generate (reusable) / generate` and `Auto-PR create (reusable) / create` before merging. [Step 8](#step-8-configure-branch-protection-optional) |

**Quick setup:** `npx -p github:knirski/auto-pr auto-pr-init` → GitHub App + secrets (Steps 2–5) → push to `ai/**`.

## Overview

1. **AI agent** (or developer) pushes a branch (e.g. `ai/feature-x` or `ai/fix-y`)
2. **Workflow** runs on push to `ai/**` branches (title from first commit subject; for 2+ commits: AI generates description)
3. **GitHub App** creates or updates the PR using its token
4. **PR** is opened by `your-app-name[bot]` → you approve it

## Step 1 (optional): Install the package for local CLI

**Skip this step** unless you run auto-pr CLIs on your machine. The default reusable workflow fetches auto-pr from `knirski/auto-pr` and needs **no** dependency on auto-pr in your `package.json`.

When you do install from git (e.g. `npx -p github:knirski/auto-pr` or `bun add github:knirski/auto-pr`), the package works with Node only: `dist/` is pre-built and committed by CI. With Bun, `prepare` also builds it on install.

**JS/TS projects:** The generate and create jobs auto-detect your runtime (npm, yarn, pnpm, bun) from `packageManager` or lockfile. No config needed.

## Step 2: Create the GitHub App

1. Go to [github.com/settings/apps/new](https://github.com/settings/apps/new)
2. Fill in:
   - **GitHub App name**: e.g. `my-repo-auto-pr-bot` (must be unique)
   - **Homepage URL**: Your repo URL
   - **Webhook**: Uncheck **Active** (not needed)
3. Under **Repository permissions**:
   - **Contents**: Read and write
   - **Pull requests**: Read and write
   - **Actions**: Read and write (if you use workflows that push)
4. Under **Where can this GitHub App be installed?**: Choose **Only on this account**
5. Click **Create GitHub App**

## Step 3: Generate and save the private key

1. On the app's settings page, scroll to **Private keys**
2. Click **Generate a private key**
3. Save the `.pem` file securely. You'll need its contents for a secret.

## Step 4: Install the app on your repo

1. On the app settings page, click **Install App**
2. Choose **Only select repositories** and select your repo
3. Click **Install**

## Step 5: Add repository secrets

1. Go to your repo → **Settings** → **Secrets and variables** → **Actions**
2. Add these repository secrets:

| Secret name | Value |
|-------------|-------|
| `APP_ID` | Your app's App ID (from app settings, "About") |
| `APP_PRIVATE_KEY` | Full contents of the `.pem` file |

Optional: **`GH_TOKEN`** — only for local CLI use or advanced workflows that intentionally provide a separate GitHub Models token. The stock [auto-pr.yml](../.github/workflows/auto-pr.yml) passes the default **`github.token`** to the generate workflow and grants **`models: read`**. Avoid forwarding a long-lived PAT secret to the generate job: that job checks out branch code by design.

`APP_*` are used by the create job (and release-please if you use it).

## Step 6: Add the workflow file

**Recommended:** Run `npx -p github:knirski/auto-pr auto-pr-init` — creates the workflow, PR template, `.nvmrc`, and `.github/llama-server/Dockerfile` in one command. The reusable generate job runs through pinned reusable actions in `knirski/auto-pr`; you do not need `scripts/` in your repository.

**Manual:** Copy [auto-pr.yml](../.github/workflows/auto-pr.yml) to `.github/workflows/auto-pr.yml` in your repo. The workflow calls two reusable workflows (generate + create) and pins to a commit SHA for reproducible runs; do not change the ref unless you intend to upgrade.

**No action copying required.** The reusable workflows fetch repo-owned actions from `knirski/auto-pr`. A relative `./` path would resolve to your repo; we use full paths so you do not need anything under `.github/actions/` in your project. The model routing context step runs as a packaged auto-pr command, so your repository does not need Bun, `node_modules`, or auto-pr source files.

All inputs use sensible defaults for the AI model. The PR template path is always `.github/PULL_REQUEST_TEMPLATE.md` at the repo root. Edit the **How to test** section in that file directly for project-specific steps (for example `npm run check` or `pytest`). Override other options via `with:` when needed.

**Run checks first:** See [Running checks before PR creation](#running-checks-before-pr-creation) to add a check job before generate/create.

## Step 7: Add the PR template

`npx -p github:knirski/auto-pr auto-pr-init` creates this automatically. Otherwise, copy [.github/PULL_REQUEST_TEMPLATE.md](../.github/PULL_REQUEST_TEMPLATE.md) to your repo. Customize placeholders if needed.

## Step 8: Configure branch protection (optional)

To require the auto-pr workflow and your CI to pass before merging PRs into `main`:

1. Go to **Settings** → **Branches** → **Add rule** (or edit the rule for `main`)
2. Set **Branch name pattern** to `main` (or your default branch)
3. Enable **Require status checks to pass before merging**
4. Search for and add:
   - **`Auto-PR generate (reusable) / generate`** — content generation (checkout + template fill)
   - **`Auto-PR create (reusable) / create`** — PR creation/update
   - Your CI job(s), e.g. **`check / check`** or **`test`** — if you have workflows that run on `pull_request`
5. Optionally enable **Require branches to be up to date before merging** (strict mode)
6. Save the rule

**Note:** Status checks must have run successfully in the past 7 days to appear in the list. Push an `ai/**` branch and open a PR first if `Auto-PR generate (reusable) / generate` is missing.

See [Managing a branch protection rule](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule) and [Troubleshooting required status checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks).

## Step 9: Use the right branch names

When creating changes, use branch names that match the workflow:

- `ai/feature-name`
- `ai/fix-bug-description`

Or adjust the `branches` filter in the workflow.

## Running checks before PR creation

To run your tests or checks before PR creation, add a `check` job and make `generate` depend on it. Edit the check job for your stack.

**Pattern:** Add a job before `generate` and set `needs: check` on the generate job:

```yaml
jobs:
  check:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          ref: ${{ github.ref_name }}
          fetch-depth: 0
      # Add your stack's setup and run command below
      - name: Check
        run: echo "Add your check command (npm run check, pytest, cargo test, etc.)" && exit 1

  generate:
    needs: check
    uses: knirski/auto-pr/.github/workflows/auto-pr-generate-reusable.yml@<SHA>

  create:
    needs: generate
    uses: knirski/auto-pr/.github/workflows/auto-pr-create-reusable.yml@<SHA>
    secrets: inherit
```

**Node/npm example:**

```yaml
  check:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          ref: ${{ github.ref_name }}
          fetch-depth: 0
      - uses: actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f # v6.3.0
        with:
          node-version-file: ".nvmrc"
          cache: "npm"
      - run: npm ci
      - run: npm run check
```

**Bun/pnpm/yarn:** Use `oven-sh/setup-bun`, `pnpm/action-setup` + `actions/setup-node`, or `actions/setup-node` with `cache: "yarn"` respectively. The generate and create jobs auto-detect your runtime; your check job should match.

**Python example:**

```yaml
  check:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          ref: ${{ github.ref_name }}
          fetch-depth: 0
      - uses: actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065 # v5
        with:
          python-version: "3.12"
      - run: pip install -e ".[dev]"
      - run: pytest
```

Adjust the install step for your project (e.g. `pip install -r requirements.txt`, `uv sync`).

**Rust example:**

```yaml
  check:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          ref: ${{ github.ref_name }}
          fetch-depth: 0
      - run: cargo test
```

Replace `<SHA>` with the SHA from the `uses:` lines in [auto-pr.yml](../.github/workflows/auto-pr.yml).

## Common customizations

| I want to… | Set |
|------------|-----|
| Use my project's check command in "How to test" | Edit the **How to test** section in `.github/PULL_REQUEST_TEMPLATE.md` |
| Use a different GitHub Models id | Not a workflow input; `github-models` is selected by routing and catalog fallback. Use `local` for a fixed external gateway/model. |
| Point **local** at another host or gateway | `ai_openai_compat_url` and optionally `ai_openai_compat_api_key`. The reusable workflow uses the local default model id; custom scripts/env can set `AUTO_PR_LOCAL_MODEL`. |
| Run **local** on GitHub-hosted runners with llama.cpp | `ai_provider: local`, leave `ai_openai_compat_url` empty, set **`ai_llamacpp_model_url`** (HTTPS link to a `.gguf` file). Optional: `ai_llamacpp_release_tag` (Docker image override), `ai_llamacpp_port`. The workflow uses `.github/llama-server/Dockerfile` for the image pin, caches the GGUF and Docker image tar, and runs `llama-server` in Docker. |
| Run checks before PR creation | Add a `check` job; set `needs: check` on generate (see [Running checks before PR creation](#running-checks-before-pr-creation)) |

### Local llama Dockerfile pin

- **Purpose:** Pins the `llama-server` Docker image when the reusable workflow runs llama in Docker (`ai_llamacpp_model_url` set, `ai_openai_compat_url` empty).
- **Tag vs digest:** The template uses a **tag** on `FROM` (e.g. `ghcr.io/ggml-org/llama.cpp:server`) so [Dependabot](https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/configuration-options-for-the-dependabot.yml-file#docker) can propose image updates. For a **stricter immutable** pin, use `image@sha256:…` on the same line (Dependabot behavior may differ from tag-only pins).
- **Parser limits (workflow + tests):** Only the **first** `FROM` is used, after optional `--` flags (e.g. `--platform=…`). There is **no** support for backslash line continuation or for picking a later stage in a **multi-stage** file—keep this file **single-stage**, or ensure the image you need appears on the **first** `FROM`.
- **Docker llama composite actions:** Start/stop are [`llama-server-docker-start`](../.github/actions/llama-server-docker-start) and [`llama-server-docker-stop`](../.github/actions/llama-server-docker-stop) (pinned in the reusable workflow). The start script uses **`docker cp`** to place the GGUF in the container (not a bind mount), so nested Docker (e.g. [act](https://github.com/nektos/act)) does not depend on host path alignment for `-v`. Default container name is **`auto-pr-llama`**; pass **`container_name`** when several jobs share one Docker host ([nektos/act](https://github.com/nektos/act) runs parallel jobs on a single machine). Assume **one** `llama-server` container per job unless you use distinct **`container_name`** and **host port** values. If you copy those composite actions into a custom workflow and need two local servers in the **same** job, use different **`container_name`** / **`llama_port`** inputs or run them in **separate** jobs.
- **Runner cache layout:** The start action (`llama-server-docker-start`) takes **`llama_server_root`**. Under that directory it stores `model/model.gguf` and `docker/llama-server-image.tar` for `actions/cache`. This repo’s **integration** workflow uses **`${{ github.workspace }}/.cache/auto-pr-llama-stub`** / **`…-model`** so paths stay under the checkout (nested **`docker -v`** from [act](https://github.com/nektos/act) matches the host). Each integration job picks an **ephemeral TCP port** on the runner via an inline **`python3`** one-liner in [integration.yml](../.github/workflows/integration.yml) (`bind(127.0.0.1, 0)` — Python is preinstalled on GitHub-hosted Ubuntu; not inside nested containers). The **generate** reusable workflow still uses **`${{ runner.temp }}/auto-pr-llama`** for hosted runs.

## AI providers (`local`, `github-models`)

For branches with **2+ commits**, auto-pr generates the PR description via an AI backend. Choose a provider with `ai_provider` on the generate reusable workflow (maps to `AUTO_PR_AI_PROVIDER`), or set env when running locally.

Before the model call, the reusable workflow builds a routing context from commit metadata, changed-file classes, diff churn, dependency/workflow/generated-file signals, runner resources, and local-model sizing risk. That context selects a model band, sets the local-model fallback when one is not provided, chooses whether the later prompt should rely on diff tools, and is injected into the prompt as structured reviewer context. The prompt still includes commit messages separately; the routing context summarizes signals that commit messages do not reliably encode.

**How it calls the model:** The generate step uses **`LanguageModel.generateText`** with a prompt that asks for JSON (`title`, `motivation`, `benefits`, `risks`, `notesForReviewers`). It parses the assistant reply and validates with Effect Schema — not OpenAI **`generateObject`** / **`json_schema`**, because GitHub Models does not support that response format and other OpenAI-compatible servers are inconsistent with it. On repeated parse or transient HTTP failures (network, rate limit, 5xx), auto-pr falls back to commit-derived title and description. **Authentication errors (HTTP 401/403) surface directly as a configuration error** rather than silently falling back — check your `GH_TOKEN` or `AUTO_PR_AI_OPENAI_COMPAT_API_KEY` if you see an auth error in the generate step.

### Provider defaults

Defaults differ by entry point so local development can run against a local OpenAI-compatible server, while the stock GitHub workflow works without hosting a model yourself.

| Entry point | Provider default | Model default | Notes |
|-------------|------------------|---------------|-------|
| Stock [`auto-pr.yml`](../.github/workflows/auto-pr.yml) | `github-models` | selected by routing and catalog fallback | The workflow grants `models: read`, builds `AUTO_PR_ROUTING_DECISION_JSON`, and passes `github.token` to the generate reusable workflow. |
| Generate reusable workflow with `ai_provider: local` and `ai_llamacpp_model_url` | `local` | llama-server `/v1/models` id after startup; before startup the router falls back to a GitHub-runner-sized local default (`qwen3-1.7b-q4_k_m` for private/internal `ubuntu-24.04`, `qwen3-4b-q4_k_m` for public `ubuntu-24.04`) | Starts `llama-server` in Docker and uses the local OpenAI-compatible endpoint. The routing context flags GGUF URLs that appear too large for the resolved runner resources. External `ai_openai_compat_url` endpoints use the local default model unless `AUTO_PR_LOCAL_MODEL` is set in a custom script/env. |
| Local CLI / `bun run generate-content` with no AI env | `local` | `gpt-oss` | Targets `http://127.0.0.1:8080/v1`. |
| Local CLI / custom workflow with `AUTO_PR_AI_PROVIDER=github-models` | `github-models` | from `AUTO_PR_ROUTING_DECISION_JSON.selectedModel` | Export `GH_TOKEN`; model is selected automatically from routing + catalog fallback. |

### `local` (OpenAI-compatible HTTP)

Any OpenAI-compatible endpoint (llama.cpp `llama-server`, remote gateways, etc.) using the same env names as in [`src/auto-pr/config.ts`](../src/auto-pr/config.ts): `AUTO_PR_AI_OPENAI_COMPAT_URL`, optional `AUTO_PR_AI_OPENAI_COMPAT_API_KEY`, and `AUTO_PR_LOCAL_MODEL`.

- **Workflow:** `ai_provider: local` and set `ai_openai_compat_url`, and optionally `ai_openai_compat_api_key` if your server requires a key — **or** omit `ai_openai_compat_url` and set **`ai_llamacpp_model_url`** to an HTTPS `.gguf` URL so the reusable workflow uses `.github/llama-server/Dockerfile` for the image pin, caches the GGUF and image tar, and starts `llama-server` in Docker on `127.0.0.1` (port from `ai_llamacpp_port`, default `8080`).
- **CI:** Prefer **`github-models`** when you do not want to host a model on the runner. For **local** on GitHub-hosted runners, either use **`ai_llamacpp_model_url`** (Docker + `Dockerfile` pin + cache), run inference on a **self-hosted** runner, or expose your server via a tunnel and set `ai_openai_compat_url` accordingly. Standard GitHub-hosted runner RAM is limited, so use small Q4-class GGUFs for the bundled path unless you move to a larger/self-hosted runner.
- **Local dev:** Defaults target `http://127.0.0.1:8080/v1` and model `gpt-oss` (override via env).

### `github-models`

Uses the [GitHub Models](https://github.com/marketplace/models) inference API (`https://models.github.ai/inference`) with an OpenAI-compatible client.

- **Token:** The stock entry workflow passes the default Actions **`github.token`** and grants `models: read`. For local scripts, export `GH_TOKEN`. For custom workflows, pass a separate token only when you accept that the generate job checks out branch code.
- **Workflow:** Default is `ai_provider: github-models`; model is derived automatically from routing and catalog capability/rate-limit fallback.
- **Env (local / scripts):** `AUTO_PR_AI_PROVIDER=github-models`, `GH_TOKEN=...`, `AUTO_PR_ROUTING_DECISION_JSON=...`, and optional `AUTO_PR_ROUTING_CONTEXT_JSON=...`.
- **Legal model ids:** The catalog is published as JSON — see [REST: List all models](https://docs.github.com/en/rest/models/catalog#list-all-models). Fetch and read each entry’s **`id`** (format `publisher/model`):

  ```bash
  curl -sL https://models.github.ai/catalog/models
  ```

  To list ids only:

  ```bash
  curl -sL https://models.github.ai/catalog/models | jq -r '.[].id' | sort
  ```

  The catalog includes embedding-only models; for PR text generation, pick an entry whose **`supported_output_modalities`** includes **`text`** (or use a known chat model id such as `openai/gpt-4.1`).

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md#ai-provider--2-commits) for common failures.

## Verification

1. Create and push a branch:

   ```bash
   git checkout -b ai/test-setup
   git commit --allow-empty -m "chore: test auto-PR workflow"
   git push origin ai/test-setup
   ```

2. Check **Actions** in your repo — the workflow should run
3. A new PR should appear, opened by `your-app-name[bot]`

## Environment variables reference

| Command | Required | Optional |
|---------|----------|----------|
| **auto-pr-generate-content** | `DEFAULT_BRANCH`, `BRANCH`, `GITHUB_WORKSPACE` | `AUTO_PR_AI_PROVIDER` (optional; default `local`), `AUTO_PR_AI_OPENAI_COMPAT_URL` / `AUTO_PR_AI_OPENAI_COMPAT_API_KEY` / `AUTO_PR_LOCAL_MODEL` (local), `GH_TOKEN` + `AUTO_PR_ROUTING_DECISION_JSON` (github-models), `AUTO_PR_ROUTING_CONTEXT_JSON` (trusted workflow-built signal summary for the AI prompt). Fetches commits, files, and diff stat directly from git via `GitContext`. Writes `pr-title.txt` and `pr-body.md`. PR template: `{GITHUB_WORKSPACE}/.github/PULL_REQUEST_TEMPLATE.md` — edit **How to test** in that file for project-specific copy. |
| **auto-pr-create-or-update-pr** | `GH_TOKEN`, `BRANCH`, `DEFAULT_BRANCH`, `GITHUB_WORKSPACE` | — (reads `{GITHUB_WORKSPACE}/pr-title.txt` and `pr-body.md`) |

Override AI-related defaults via workflow `with:` inputs when needed.

### Contributors: `knirski/auto-pr` integration tests

If you work on **this** repository (not only consuming the workflow), `bun run test:integration` uses committed [`.env.ci`](../.env.ci) and an optional gitignored `.env.local` for local overrides. Variable names and behavior are documented in [CI.md](CI.md#integration-tests) and [CONTRIBUTING.md](../CONTRIBUTING.md#integration-test-env-this-repository).

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Workflow doesn't run | Ensure branch name matches `ai/**`; workflow runs on forks too (add secrets to enable) |
| "workflow was not found" / "failed to fetch workflow" | The pinned SHA may not exist. Run `npx -p github:knirski/auto-pr auto-pr-init` to get the latest workflow, or copy [auto-pr.yml](../.github/workflows/auto-pr.yml) from main. Contributors: when testing on a branch, update all `@SHA` refs to the current commit (`git rev-parse HEAD`). See [TROUBLESHOOTING.md](TROUBLESHOOTING.md#workflow-was-not-found-or-failed-to-fetch-workflow). |
| "Missing [path]" (PR template) | Run `npx -p github:knirski/auto-pr auto-pr-init` or copy the template to the path shown. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| "node-version-file" error | Ensure `.nvmrc` exists (run `npx -p github:knirski/auto-pr auto-pr-init`). Use `node-version-file: ".nvmrc"` for single source of truth. |
| Check job fails | Ensure your check command exists (e.g. `npm run check`, `pytest`, `cargo test`). See [Running checks before PR creation](#running-checks-before-pr-creation) |
| "Resource not accessible" | Check app permissions (Contents, Pull requests, Actions: Read and write) |
| "Secret not found" | Verify `APP_ID` and `APP_PRIVATE_KEY` in repo secrets |
| PR already exists | Workflow updates the PR title and body from the latest commits |
| AI provider returns invalid description | Retries up to five attempts; description override may be empty on failure |
