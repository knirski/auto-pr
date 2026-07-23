# Integration Guide

This guide walks through adding auto-pr to any repository so that `ai/**` branches get a well-structured pull request created or updated for them. Generation is started manually (`workflow_dispatch`) or automatically by a scheduled discovery job — **not** on push. See [How generation is triggered](#how-generation-is-triggered) for why (short answer: a `push`-triggered workflow cannot be a trust boundary against the pusher — [ADR 0016](../docs/adr/0016-immutable-privileged-workflow-executor.md)).

**Already running the old single-`auto-pr.yml` version?** Jump to [Upgrading from the single-workflow version](#upgrading-from-the-single-workflow-version) — you must migrate manually; re-running `auto-pr-init` will refuse to proceed until you replace the old push-triggered file.

**Typical setup:** GitHub Actions only — `auto-pr-init`, GitHub App, a protected **environment** holding the App secrets, then trigger the workflow. No `package.json` or install of auto-pr in your repo; reusable workflows pull from `knirski/auto-pr`. **Optional:** install or `npx -p github:knirski/auto-pr …` to run CLIs locally — [Step 1 (optional)](#step-1-optional-install-the-package-for-local-cli).

## Getting started

1. **Run** `npx -p github:knirski/auto-pr auto-pr-init` in your repo — creates **both** workflows (`.github/workflows/auto-pr.yml` for the unprivileged generate/discover phase and `.github/workflows/auto-pr-create.yml` for the privileged create phase), the PR template, `.nvmrc`, and `.github/llama-server/Dockerfile` (llama-server image pin when using local Docker llama)
2. **Create** a [GitHub App](https://github.com/settings/apps/new) with Contents and Pull requests (Read and write)
3. **Generate** a private key in the app settings and save the `.pem` file
4. **Install** the app on your repository
5. **Create** a protected **environment** named `app-credentials` (deployment branch policy restricted to your default branch, admin-bypass disabled) and add `APP_ID` and `APP_PRIVATE_KEY` **to that environment** — not as plain repository secrets. See [Step 5](#step-5-create-the-protected-environment-and-add-app-credentials).
6. **Test** — trigger a run for one branch: `gh workflow run auto-pr.yml -f branch=ai/test` (or **Actions → Auto-PR → Run workflow**, set the `branch` input). Scheduled discovery then runs automatically about every 15 minutes.

No `package.json` required. Works with any project (Node, Python, Rust, etc.). No Nix required.

## Repository setup checklist

| Requirement | How to set up |
|-------------|---------------|
| **Both workflows + template** | Run `npx -p github:knirski/auto-pr auto-pr-init` in your repo. Creates `.github/workflows/auto-pr.yml`, `.github/workflows/auto-pr-create.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, `.nvmrc`, and `.github/llama-server/Dockerfile`. [Step 6](#step-6-add-the-workflow-files) |
| **GitHub App** | Create at [github.com/settings/apps/new](https://github.com/settings/apps/new). Permissions: Contents, Pull requests (Read and write). [Step 2](#step-2-create-the-github-app) |
| **Private key** | Generate in the app settings → Private keys. Save the `.pem` file. [Step 3](#step-3-generate-and-save-the-private-key) |
| **App installed** | Install the app on your repository (Install App → select repo). [Step 4](#step-4-install-the-app-on-your-repo) |
| **Protected environment** | Create an environment `app-credentials` (branch policy = default branch only, admin-bypass disabled) and add `APP_ID` / `APP_PRIVATE_KEY` **to the environment**, not as repository secrets. (Optional: `GH_TOKEN` repo secret to override the default token for GitHub Models.) [Step 5](#step-5-create-the-protected-environment-and-add-app-credentials) |
| **Branch protection** | (Optional) Require `Auto-PR generate (reusable) / generate` and `Auto-PR create (reusable) / create` before merging. [Step 8](#step-8-configure-branch-protection-optional) |

**Quick setup:** `npx -p github:knirski/auto-pr auto-pr-init` → GitHub App + protected environment (Steps 2–5) → `gh workflow run auto-pr.yml -f branch=ai/…`.

## Overview

1. **AI agent** (or developer) pushes a branch (e.g. `ai/feature-x` or `ai/fix-y`)
2. **Generation is triggered** either manually (`workflow_dispatch` with a `branch` input) or by the scheduled discovery job that finds `ai/**` branches without an open PR (about every 15 minutes; realistically 10–30+ min end-to-end). The unprivileged **generate** phase (title from first commit subject; for 2+ commits: AI generates description) produces a data-only artifact.
3. **A separate, default-branch-only privileged workflow** (`auto-pr-create.yml`, `workflow_run`-triggered) validates that artifact and mints a **GitHub App** token — gated by the `app-credentials` environment — to create or update the PR.
4. **PR** is opened by `your-app-name[bot]` → you approve it

See [How generation is triggered](#how-generation-is-triggered) and [ADR 0016](../docs/adr/0016-immutable-privileged-workflow-executor.md) for the trust-boundary rationale.

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

## Step 5: Create the protected environment and add App credentials

The App credentials (`APP_ID` / `APP_PRIVATE_KEY`) must live on a **protected GitHub Actions environment**, not as plain repository secrets. Repository secrets are readable by any workflow run in the repo — including one defined by a pushed `ai/**` branch — so the App token would be reachable by an untrusted branch author. An environment secret is only readable once the environment's protection rules pass, and the deployment branch policy is matched against the running ref. This is the **load-bearing control** of the whole design ([ADR 0016](../docs/adr/0016-immutable-privileged-workflow-executor.md) decision 8).

1. Go to your repo → **Settings** → **Environments** → **New environment**. Name it exactly **`app-credentials`**.
2. **Deployment branches and tags:** choose **Selected branches and tags** and add a rule for your **default branch only** (e.g. `main`). Do not use "All branches". (Avoid "Protected branches only" unless your default branch actually has branch protection — otherwise the policy can misbehave.)
3. **Disable** "Allow administrators to bypass configured protection rules".
4. **Required reviewers are not a meaningful control here** — on a single-owner repo there is effectively no independent second reviewer, so do not rely on them. The deployment branch policy is what keeps the secret unreachable from an `ai/**` branch.
5. Under the environment, add these **environment secrets**:

   | Secret name | Value |
   |-------------|-------|
   | `APP_ID` | Your app's App ID (from app settings, "About") |
   | `APP_PRIVATE_KEY` | Full contents of the `.pem` file |

   **First-time setup:** add them straight to the environment — there is nothing to migrate. **Upgrading from repo secrets:** see [Upgrading from the single-workflow version](#upgrading-from-the-single-workflow-version).

> **Note:** `auto-pr-init` cannot do any of this for you. It is a local file-copy tool with no GitHub API access — it never creates the environment, sets branch policies, or writes secrets. Those are manual steps for every adopter, first-time or upgrading.

**⚠️ Create the environment BEFORE the workflows first run — skipping it or doing it out of order fails silently, not loudly.** If a workflow references an environment name that does not yet exist, GitHub **auto-creates it with no protection rules** on first reference instead of erroring. You would silently get an *unprotected* `app-credentials` environment (all branches may deploy, the App secret reachable from any `ai/**` branch) — defeating the entire control with no visible failure. Always create the protected environment (with the default-branch-only deployment policy above) **before** any workflow that names it runs.

**Verify the live environment is actually protected.** YAML cannot prove GitHub's live environment config; only the API can. After creating the environment, and again after any change to it, run the settings check against your repo:

```bash
scripts/check-app-credentials-environment.sh <owner>/<repo>   # add env name if not `app-credentials`
```

It asserts (via `gh api`) that admin-bypass is disabled, a *custom* deployment-branch policy exists (not "all branches" / not the silent auto-created default), that the policy lists **exactly** your default branch, and that both `APP_ID` and `APP_PRIVATE_KEY` exist as environment secrets. It exits non-zero with a clear message on any failure. Requires `gh` (authenticated) and `jq`. Run it in particular **before removing any repository-level `APP_ID`/`APP_PRIVATE_KEY` secrets**.

**If environments are unavailable on your plan.** Deployment-branch-policy environments are free for **public** repositories on all plans, but for **private** repositories they require GitHub **Pro/Team/Enterprise** ([ADR 0016](../docs/adr/0016-immutable-privileged-workflow-executor.md) research finding 7). If your repo is private on a plan without environments, the protected-environment control — the load-bearing gate of this whole design — **cannot be enforced**, and required reviewers are not a substitute (on a single-owner repo there is no independent reviewer anyway). Per [ADR 0016](../docs/adr/0016-immutable-privileged-workflow-executor.md) decision 9, do **not** enable the automatic privileged create path in that configuration: without the environment gate the App secret is reachable by any same-repo branch — the exact defect this design fixes. Your options are to (a) make the repo public, (b) upgrade to a plan that offers environments, or (c) accept and clearly document a narrower threat model (e.g. only fully-trusted collaborators can push branches at all, so "any same-repo pusher is untrusted" no longer applies). Building an external secret broker is an alternative but is out of scope for this project's stock setup.

Optional: **`GH_TOKEN`** (repository secret) — only for local CLI use or advanced workflows that intentionally provide a separate GitHub Models token. The stock [auto-pr.yml](../.github/workflows/auto-pr.yml) passes the default **`github.token`** to the generate workflow and grants **`models: read`**. Avoid forwarding a long-lived PAT secret to the generate job: that job checks out branch code by design.

`APP_*` are used by the create job (and release-please if you use it).

## Step 6: Add the workflow files

**Recommended:** Run `npx -p github:knirski/auto-pr auto-pr-init` — creates **both** workflows (`auto-pr.yml` + `auto-pr-create.yml`), the PR template, `.nvmrc`, and `.github/llama-server/Dockerfile` in one command. The reusable generate job runs through pinned reusable actions in `knirski/auto-pr`; you do not need `scripts/` in your repository.

Both files are required and work as a pair: `auto-pr.yml` is the unprivileged **generate/discover** ingress (`workflow_dispatch` + `schedule`, no secrets, no `pull-requests: write`); `auto-pr-create.yml` is the privileged **create** phase, triggered by `workflow_run` after generate completes. GitHub always evaluates a `workflow_run`-triggered workflow's definition from the **default branch**, so a pushed branch can never substitute the privileged file, its permissions, or the executor it runs.

**Manual:** Copy both [auto-pr.yml](../.github/workflows/auto-pr.yml) and [auto-pr-create.yml](../.github/workflows/auto-pr-create.yml) to `.github/workflows/` in your repo. Each pins its reusable workflows to a commit SHA for reproducible runs; do not change the refs unless you intend to upgrade.

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

Use branch names under `ai/**` — both the scheduled discovery job and the `workflow_dispatch` `branch` input only accept `ai/**` branches:

- `ai/feature-name`
- `ai/fix-bug-description`

To use a different prefix, adjust the `ai/**` patterns in the `discover` job and the `workflow_dispatch` input validation in `auto-pr.yml`.

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

## How generation is triggered

Push no longer starts generation. A `push`-triggered workflow is defined by the pushed branch, so a same-repository branch author would control the privileged workflow, its permissions, and the code it runs — see [ADR 0016](../docs/adr/0016-immutable-privileged-workflow-executor.md). The trusted ingress is instead:

- **Manual (`workflow_dispatch`) — immediate, the baseline.** Run the generate workflow for one explicit `ai/**` branch:

  ```bash
  gh workflow run auto-pr.yml -f branch=ai/your-branch
  ```

  Or **Actions → Auto-PR → Run workflow**, then set the **`branch`** input. This is the fastest way to test and always available on every plan.

- **Scheduled discovery (`schedule`) — automatic, ongoing.** A cron job (about every 15 minutes) discovers `ai/**` branches that have no open PR yet and generates for them. GitHub's scheduled runs are best-effort and frequently delayed, so realistic end-to-end latency is **10–30+ minutes, not seconds**. This is the documented cost of dropping push as the trusted entry point.

- **`repository_dispatch` — advanced, opt-in, seconds-latency.** If you genuinely need near-instant generation, you can operate an external GitHub App / webhook receiver that listens for pushes to `ai/**` and fires a `repository_dispatch`. This is **documented, not built in** ([ADR 0016](../docs/adr/0016-immutable-privileged-workflow-executor.md) Option C): it requires you to run and secure a network service holding a dispatch-capable credential, converting "copy some YAML" into "operate a service". Its blast radius is bounded by the create phase's validation, but it is net-new attack surface — use only if the latency of scheduled discovery is unacceptable.

## Upgrading from the single-workflow version

Earlier auto-pr shipped a single `push`-triggered `.github/workflows/auto-pr.yml` that contained the privileged `create` job. That is unsafe: a same-repository branch author supplies the pushed workflow definition and can therefore reach the App token ([ADR 0016](../docs/adr/0016-immutable-privileged-workflow-executor.md), one-line summary: a `push`-triggered workflow cannot be a trust boundary against the pusher). The fix splits it into an unprivileged push-free `auto-pr.yml` and a separate default-branch-only privileged `auto-pr-create.yml`, and moves the App secrets onto a protected environment.

`auto-pr-init` **will not migrate you automatically** and, by design, **refuses to silently succeed** if it finds your old push-triggered `auto-pr.yml`: it leaves the file untouched and exits non-zero with an "ACTION REQUIRED" message, so an upgrade can never look done while leaving the vulnerable file in place. Migrate manually:

1. **Replace `auto-pr.yml`.** Overwrite your existing `.github/workflows/auto-pr.yml` with the new push-free version ([auto-pr.yml](../.github/workflows/auto-pr.yml)) — it triggers only on `workflow_dispatch` + `schedule` and has no privileged `create` job.
2. **Add `auto-pr-create.yml`.** Copy [auto-pr-create.yml](../.github/workflows/auto-pr-create.yml) into `.github/workflows/`. After both files are in place, re-running `npx -p github:knirski/auto-pr auto-pr-init` will proceed normally (it detects the new shape) and fill in anything still missing.
3. **Create the protected `app-credentials` environment** with a default-branch-only deployment policy and admin-bypass disabled — see [Step 5](#step-5-create-the-protected-environment-and-add-app-credentials).
4. **Move your App credentials into the environment.** GitHub has no API to copy a secret's value, so re-enter the `APP_ID` / `APP_PRIVATE_KEY` values you already have as **environment** secrets on `app-credentials`:

   ```bash
   gh secret set APP_ID --env app-credentials --repo <owner>/<repo>
   gh secret set APP_PRIVATE_KEY --env app-credentials --repo <owner>/<repo> < path/to/private-key.pem
   ```

   (Or add them via the environment's UI.) **Keep your existing repository-level `APP_ID` / `APP_PRIVATE_KEY` secrets in place until** the new workflow has successfully created a PR end-to-end, then remove the repository-level copies. This is exactly the sequencing `knirski/auto-pr` itself used when adopting the design (create environment → set environment secrets → verify → remove repo-level secrets). Before removing the repository-level copies, run `scripts/check-app-credentials-environment.sh <owner>/<repo>` (see [Step 5](#step-5-create-the-protected-environment-and-add-app-credentials)) and confirm it passes — otherwise you may be relying on an unprotected auto-created environment while the still-present repository secrets mask the misconfiguration.
5. **Verify** with a manual dispatch (`gh workflow run auto-pr.yml -f branch=ai/your-branch`) before relying on scheduled discovery.

## Verification

1. Create and push a branch:

   ```bash
   git checkout -b ai/test-setup
   git commit --allow-empty -m "chore: test auto-PR workflow"
   git push origin ai/test-setup
   ```

2. Trigger generation for it (push alone does not start it):

   ```bash
   gh workflow run auto-pr.yml -f branch=ai/test-setup
   ```

3. Check **Actions** in your repo — the **Auto-PR** (generate) run appears, then the **Auto-PR create** run starts via `workflow_run`
4. A new PR should appear, opened by `your-app-name[bot]`. (Left to scheduled discovery instead of a manual dispatch, this can take 10–30+ minutes.)

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
| Nothing happens after pushing an `ai/**` branch | Push does not start generation anymore. Trigger it manually (`gh workflow run auto-pr.yml -f branch=ai/…`) or wait for scheduled discovery (10–30+ min). See [How generation is triggered](#how-generation-is-triggered). |
| Workflow doesn't run at all | Ensure both `auto-pr.yml` and `auto-pr-create.yml` exist; the `branch` input / discovered branch must match `ai/**`. |
| "workflow was not found" / "failed to fetch workflow" | The pinned SHA may not exist. Run `npx -p github:knirski/auto-pr auto-pr-init` to get the latest workflows, or copy [auto-pr.yml](../.github/workflows/auto-pr.yml) and [auto-pr-create.yml](../.github/workflows/auto-pr-create.yml) from main. Contributors: when testing on a branch, update all `@SHA` refs to the current commit (`git rev-parse HEAD`). See [TROUBLESHOOTING.md](TROUBLESHOOTING.md#workflow-was-not-found-or-failed-to-fetch-workflow). |
| "Missing [path]" (PR template) | Run `npx -p github:knirski/auto-pr auto-pr-init` or copy the template to the path shown. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| "node-version-file" error | Ensure `.nvmrc` exists (run `npx -p github:knirski/auto-pr auto-pr-init`). Use `node-version-file: ".nvmrc"` for single source of truth. |
| Check job fails | Ensure your check command exists (e.g. `npm run check`, `pytest`, `cargo test`). See [Running checks before PR creation](#running-checks-before-pr-creation) |
| "Resource not accessible" | Check app permissions (Contents, Pull requests, Actions: Read and write) |
| "Secret not found" / "Missing secrets" | Verify `APP_ID` and `APP_PRIVATE_KEY` are set on the **`app-credentials` environment** (not only as repository secrets), and that the environment's deployment branch policy admits your default branch. See [Step 5](#step-5-create-the-protected-environment-and-add-app-credentials). |
| `auto-pr-init` exits with "ACTION REQUIRED" | Your existing `auto-pr.yml` predates the security fix (still push-triggered). Follow [Upgrading from the single-workflow version](#upgrading-from-the-single-workflow-version); the tool refuses to proceed until it is replaced. |
| PR already exists | Workflow updates the PR title and body from the latest commits |
| AI provider returns invalid description | Retries up to five attempts; description override may be empty on failure |
