# Integration Guide

This guide walks through adding auto-pr to any repository so that pushes to `ai/**` branches automatically create or update pull requests.

## Getting started

1. **Run** `npx auto-pr-init` in your repo — creates the workflow, PR template, and `.nvmrc`
2. **Create** a [GitHub App](https://github.com/settings/apps/new) with Contents and Pull requests (Read and write)
3. **Generate** a private key in the app settings and save the `.pem` file
4. **Install** the app on your repository
5. **Add** `APP_ID` and `APP_PRIVATE_KEY` to **Settings → Secrets and variables → Actions**
6. **Test** — push to an `ai/*` branch: `git checkout -b ai/test && git commit --allow-empty -m "chore: test" && git push`

No `package.json` required. Works with any project (Node, Python, Rust, etc.). No Nix required.

## Repository setup checklist

| Requirement | How to set up |
|-------------|---------------|
| **Workflow + template** | Run `npx auto-pr-init` in your repo. Creates `.github/workflows/auto-pr.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, `.nvmrc`. [Step 6](#step-6-add-the-workflow-file) |
| **GitHub App** | Create at [github.com/settings/apps/new](https://github.com/settings/apps/new). Permissions: Contents, Pull requests (Read and write). [Step 2](#step-2-create-the-github-app) |
| **Private key** | Generate in the app settings → Private keys. Save the `.pem` file. [Step 3](#step-3-generate-and-save-the-private-key) |
| **App installed** | Install the app on your repository (Install App → select repo). [Step 4](#step-4-install-the-app-on-your-repo) |
| **Secrets** | Add `APP_ID` and `APP_PRIVATE_KEY` to **Settings → Secrets and variables → Actions**. [Step 5](#step-5-add-repository-secrets) |
| **Branch protection** | (Optional) Require `Auto-PR generate (reusable) / generate` and `Auto-PR create (reusable) / create` before merging. [Step 8](#step-8-configure-branch-protection-optional) |

**Quick setup:** `npx auto-pr-init` → GitHub App (Steps 2–5) → push to `ai/**`.

## Overview

1. **AI agent** (or developer) pushes a branch (e.g. `ai/feature-x` or `ai/fix-y`)
2. **Workflow** runs on push to `ai/**` branches (title from first commit subject; for 2+ commits: Ollama generates description)
3. **GitHub App** creates or updates the PR using its token
4. **PR** is opened by `your-app-name[bot]` → you approve it

## Step 1: Add auto-pr as a dependency (optional)

**Skip this step** — the default reusable workflow uses `npx -p github:knirski/auto-pr` and needs no `package.json`.

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
2. Add two secrets:

| Secret name | Value |
|-------------|-------|
| `APP_ID` | Your app's App ID (from app settings, "About") |
| `APP_PRIVATE_KEY` | Full contents of the `.pem` file |

These secrets are used by both the auto-pr workflow and release-please (if you use it).

## Step 6: Add the workflow file

**Recommended:** Run `npx auto-pr-init` — creates the workflow, PR template, and `.nvmrc` in one command.

**Manual:** Copy [auto-pr.yml](../.github/workflows/auto-pr.yml) to `.github/workflows/auto-pr.yml` in your repo. The workflow calls two reusable workflows (generate + create) and pins to a commit SHA for reproducible runs; do not change the ref unless you intend to upgrade.

**No action copying required.** The reusable workflows fetch everything (including the setup-runtime action) from knirski/auto-pr. The `./` path would resolve to your repo; we use full paths so you don't need anything in `.github/actions/`.

All inputs use sensible defaults (Ollama model, PR template path, generic "how to test" text). Override via `with:` only when needed. **Node projects:** add `auto_pr_how_to_test: "1. Run \`npm run check\`\n2. "` to the generate job for accurate PR instructions.

**Run checks first:** See [Running checks before PR creation](#running-checks-before-pr-creation) to add a check job before generate/create.

## Step 7: Add the PR template

`npx auto-pr-init` creates this automatically. Otherwise, copy [.github/PULL_REQUEST_TEMPLATE.md](../.github/PULL_REQUEST_TEMPLATE.md) to your repo. Customize placeholders if needed.

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

Replace `<SHA>` with the SHA from the `uses:` lines in [auto-pr.yml](../.github/workflows/auto-pr.yml). Override `auto_pr_how_to_test` in the generate call if your "how to test" steps differ (Node: `"1. Run \`npm run check\`\n2. "`, Python: `"1. Run \`pytest\`\n2. "`).

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
| **auto-pr-get-commits** | `DEFAULT_BRANCH`, `GITHUB_WORKSPACE`, `GITHUB_OUTPUT` | — |
| **auto-pr-generate-content** | `COMMITS`, `FILES`, `GITHUB_OUTPUT`, `GITHUB_WORKSPACE` | `PR_TEMPLATE_PATH` (default `.github/PULL_REQUEST_TEMPLATE.md`), `OLLAMA_MODEL` (default `llama3.1:8b`), `OLLAMA_URL`, `AUTO_PR_HOW_TO_TEST` (default generic) |
| **auto-pr-create-or-update-pr** | `GH_TOKEN`, `BRANCH`, `DEFAULT_BRANCH`, `TITLE`, `BODY_FILE`, `GITHUB_WORKSPACE` | — |

Override defaults via workflow `with:` inputs when needed (e.g. Node: `auto_pr_how_to_test: "1. Run \`npm run check\`\n2. "`, Python: `"1. Run \`pytest\`\n2. "`).

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Workflow doesn't run | Ensure branch name matches `ai/**`; workflow runs on forks too (add secrets to enable) |
| "workflow was not found" / "failed to fetch workflow" | The pinned SHA may not exist. Run `npx auto-pr-init` to get the latest workflow, or copy [auto-pr.yml](../.github/workflows/auto-pr.yml) from main. Contributors: when testing on a branch, update all `@SHA` refs to the current commit (`git rev-parse HEAD`). See [TROUBLESHOOTING.md](TROUBLESHOOTING.md#workflow-was-not-found-or-failed-to-fetch-workflow). |
| "Missing [path]" (PR template) | Run `npx auto-pr-init` or copy the template to the path shown. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| "node-version-file" error | Ensure `.nvmrc` exists (run `npx auto-pr-init`). Use `node-version-file: ".nvmrc"` for single source of truth. |
| Check job fails | Ensure your check command exists (e.g. `npm run check`, `pytest`, `cargo test`). See [Running checks before PR creation](#running-checks-before-pr-creation) |
| "Resource not accessible" | Check app permissions (Contents, Pull requests, Actions: Read and write) |
| "Secret not found" | Verify `APP_ID` and `APP_PRIVATE_KEY` in repo secrets |
| PR already exists | Workflow updates the PR title and body from the latest commits |
| Ollama returns invalid description | Retries 3×; description override may be empty on failure |
