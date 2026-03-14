# Integration Guide

This guide walks through adding auto-pr to any repository so that pushes to `ai/**` branches automatically create or update pull requests.

**No Nix required.** Consumers use Node and npx only. Nix is used only by contributors to the auto-pr repo itself.

## Repository setup checklist

Before auto-pr can create PRs, your repository must have:

| Requirement | How to set up |
|-------------|---------------|
| **GitHub App** | Create at [github.com/settings/apps/new](https://github.com/settings/apps/new). Permissions: Contents, Pull requests (Read and write). [Step 2](#step-2-create-the-github-app) |
| **Private key** | Generate in the app settings → Private keys. Save the `.pem` file. [Step 3](#step-3-generate-and-save-the-private-key) |
| **App installed** | Install the app on your repository (Install App → select repo). [Step 4](#step-4-install-the-app-on-your-repo) |
| **Secrets** | Add `APP_ID` and `APP_PRIVATE_KEY` to **Settings → Secrets and variables → Actions**. [Step 5](#step-5-add-repository-secrets) |
| **Workflow** | Add `.github/workflows/auto-pr.yml`. Run `npx auto-pr-init` or copy manually. [Step 6](#step-6-add-the-workflow-file) |
| **PR template** | Add `.github/PULL_REQUEST_TEMPLATE.md`. Created by `npx auto-pr-init` or copy from this repo. [Step 7](#step-7-add-the-pr-template) |
| **Branch protection** | (Optional) Require `Auto-PR / auto-pr` and your CI checks before merging. [Step 8](#step-8-configure-branch-protection-optional) |

**Quick setup:** Run `npx auto-pr-init` in your repo to create the workflow, PR template, and `.nvmrc`. Then complete the GitHub App setup (Steps 2–5). No `package.json` required.

**Two modes:**
- **Reusable workflow** (default) — Uses `npx -p github:knirski/auto-pr`. Works with any project (Node, Python, Rust, etc.).
- **npm dependency** — Add `auto-pr` to `package.json` for `npm ci`-based workflows. See [Step 1](#step-1-add-auto-pr-as-a-dependency).

## Overview

1. **AI agent** (or developer) pushes a branch (e.g. `ai/feature-x` or `ai/fix-y`)
2. **Workflow** runs on push to `ai/**` branches (title from first commit subject; for 2+ commits: Ollama generates description)
3. **GitHub App** creates or updates the PR using its token
4. **PR** is opened by `your-app-name[bot]` → you approve it

## Step 1: Add auto-pr as a dependency

**If you have `package.json`:** Add auto-pr:

```json
{
  "dependencies": {
    "auto-pr": "github:knirski/auto-pr"
  }
}
```


**If you don't have `package.json`:** Create a minimal one so the workflow can run `npm ci`:

```bash
echo '{"name":"my-project","private":true,"dependencies":{"auto-pr":"github:knirski/auto-pr"}}' > package.json
npm install
```

Commit both `package.json` and `package-lock.json`.

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

**Option A — Reusable (recommended, no package.json):**

```bash
mkdir -p .github/workflows
curl -o .github/workflows/auto-pr.yml https://raw.githubusercontent.com/knirski/auto-pr/main/.github/workflows/auto-pr-consumer-reusable.yml
```

**Option B — npm dependency** (if you have `package.json` with auto-pr):

```bash
curl -o .github/workflows/auto-pr.yml https://raw.githubusercontent.com/knirski/auto-pr/main/.github/workflows/auto-pr-consumer.yml
```

Or create `.github/workflows/auto-pr.yml` manually (reusable workflow — no package.json):

```yaml
name: Auto-PR

on:
  push:
    branches:
      - "ai/**"

concurrency:
  group: auto-pr-${{ github.ref }}
  cancel-in-progress: true

jobs:
  auto-pr:
    if: github.event.repository.fork != true
    uses: knirski/auto-pr/.github/workflows/auto-pr-reusable.yml@main
    secrets: inherit
```

## Step 7: Add the PR template

Copy [.github/PULL_REQUEST_TEMPLATE.md](../.github/PULL_REQUEST_TEMPLATE.md) to your repo. Customize placeholders if needed (e.g. `{{howToTest}}` default).

## Step 8: Configure branch protection (optional)

To require the auto-pr workflow and your CI to pass before merging PRs into `main`:

1. Go to **Settings** → **Branches** → **Add rule** (or edit the rule for `main`)
2. Set **Branch name pattern** to `main` (or your default branch)
3. Enable **Require status checks to pass before merging**
4. Search for and add:
   - **`Auto-PR / auto-pr`** — ensures the PR was created/updated successfully
   - Your CI job(s), e.g. **`check / check`** or **`test`** — if you have workflows that run on `pull_request`
5. Optionally enable **Require branches to be up to date before merging** (strict mode)
6. Save the rule

**Note:** Status checks must have run successfully in the past 7 days to appear in the list. Push an `ai/**` branch and open a PR first if `Auto-PR / auto-pr` is missing.

See [Managing a branch protection rule](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule) and [Troubleshooting required status checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks).

## Step 9: Use the right branch names

When creating changes, use branch names that match the workflow:

- `ai/feature-name`
- `ai/fix-bug-description`

Or adjust the `branches` filter in the workflow.

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
| **auto-pr-generate-content** | `COMMITS`, `FILES`, `GITHUB_OUTPUT` | `OLLAMA_MODEL`, `OLLAMA_URL`, `GITHUB_WORKSPACE`, `AUTO_PR_HOW_TO_TEST` |
| **auto-pr-create-or-update-pr** | `GH_TOKEN`, `BRANCH`, `DEFAULT_BRANCH`, `TITLE`, `BODY_FILE` | `GITHUB_WORKSPACE` |

`AUTO_PR_HOW_TO_TEST` overrides the default "How to test" text for non-Node projects (e.g. `1. Run \`pytest\`\n2. ` for Python).

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Workflow doesn't run | Ensure branch name matches `ai/**`; workflow skips on forks |
| "Missing .github/PULL_REQUEST_TEMPLATE.md" | Run `npx auto-pr-init` or copy the template. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| "node-version-file" error | Only for Option B (npm). Create `.nvmrc` or use `node-version: '24'` |
| "Resource not accessible" | Check app permissions (Contents, Pull requests, Actions: Read and write) |
| "Secret not found" | Verify `APP_ID` and `APP_PRIVATE_KEY` in repo secrets |
| PR already exists | Workflow updates the PR title and body from the latest commits |
| Ollama returns invalid description | Retries 3×; description override may be empty on failure |
