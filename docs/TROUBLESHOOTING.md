# Troubleshooting

## Do I need Nix?

**No.** Nix is optional and only used by contributors to the auto-pr repo. Users run auto-pr via `npx` or `bunx`; the workflow auto-detects npm, yarn, pnpm, or bun from your repo. No Nix required.

## Workflow fails immediately

### "workflow was not found" or "failed to fetch workflow"

**Cause:** The reusable workflow is pinned to a commit SHA. If that SHA doesn't exist in the repo (e.g. force-pushed history, or testing on a branch), GitHub can't fetch it.

**Fix:**

- **Adopters:** Run `npx -p github:knirski/auto-pr auto-pr-init` to get the latest workflow, or copy [auto-pr.yml](../.github/workflows/auto-pr.yml) from the main branch and use the SHA from its `uses:` lines.
- **Contributors to auto-pr:** When testing workflow changes on a branch, update all `@SHA` refs to the current commit (`git rev-parse HEAD`): (1) both `uses:` refs in [auto-pr.yml](../.github/workflows/auto-pr.yml), (2) the setup-runtime ref in [auto-pr-generate-reusable.yml](../.github/workflows/auto-pr-generate-reusable.yml) and [check.yml](../.github/workflows/check.yml). After merging to main, [update-workflow-pins](../.github/actions/update-workflow-pins/README.md) runs automatically; if it didn't, run **Actions → Update workflow pins** manually.
- **Avoid a loop:** Structure commits so the last one is only SHA updates. First commit: your workflow logic changes. Second commit: update `@SHA` refs to point to the first commit (the previous one). When the workflow runs on push, it loads from that previous commit (which has the real changes), runs successfully, and does not trigger another run that would create more commits.

### "Missing .github/PULL_REQUEST_TEMPLATE.md" (or custom path)

**Cause:** The PR template is required for auto-pr to fill the body. The path is always `.github/PULL_REQUEST_TEMPLATE.md` at the repo root (resolved under `GITHUB_WORKSPACE` in scripts).

**Fix:** Run `npx -p github:knirski/auto-pr auto-pr-init` in your repo, or copy [.github/PULL_REQUEST_TEMPLATE.md](../.github/PULL_REQUEST_TEMPLATE.md) to the path shown in the error.

### "Missing secrets APP_ID or APP_PRIVATE_KEY"

**Cause:** The workflow needs a GitHub App token to create PRs.

**Fix:** Create a GitHub App (see [INTEGRATION.md](INTEGRATION.md#step-2-create-the-github-app)), install it on your repo, and add `APP_ID` and `APP_PRIVATE_KEY` to repository secrets.

**Fork contributors:** The workflow runs on forks. To test auto-PR on your fork, add the same secrets to your fork's **Settings → Secrets and variables → Actions** (create a GitHub App for your fork). Otherwise, create the PR manually from your branch to the upstream repo.

### "Missing required env: …"

**Cause:** Each script validates only the env vars it needs (see [src/auto-pr/config.ts](../src/auto-pr/config.ts)). A message listing `DEFAULT_BRANCH` / `GITHUB_WORKSPACE` usually means **generate-content** or **run-auto-pr** without a full Actions env.

**Fix:** Run inside the reusable workflow, or set the vars for the command you invoke. See [README.md](../README.md) (local env via `.env` and [`src/auto-pr/config.ts`](../src/auto-pr/config.ts)) and [INTEGRATION.md](INTEGRATION.md#environment-variables-reference).

## Generate content fails

### "No semantic commits" or "PR title is empty"

**Cause:** All commits are merge commits, or no commits match conventional format.

**Fix:** Add at least one conventional commit (e.g. `feat: add X`, `fix: resolve Y`). Merge commits are filtered out. See [Conventional Commits](https://www.conventionalcommits.org/).

### PR body or “Type of change” looks wrong when using fill-pr-template locally

**Cause:** The CLI infers **type** and **breaking** text from commits by default (first commit subject). That can differ from the PR title you intend, especially with multiple commits.

**Fix:** Pass **`--pr-title`** with the same conventional title you will use for the PR (matches what **auto-pr-generate-content** does with the generated title). See [PR_TEMPLATE.md](PR_TEMPLATE.md#fill-pr-template-cli) and [PR_TEMPLATE.md](PR_TEMPLATE.md#single-commit-vs-multi-commit-automated) for single-commit vs multi-commit behavior.

### "pr-description.txt: NotFound" or "FileSystem.readFile .../dist/prompts/pr-description.txt"

**Cause:** The prompt file is missing from the installed package. The package ships `dist/prompts/pr-description.txt`; if you're on an old version or a broken install, it may be absent.

**Fix:** Use the latest auto-pr (e.g. `npx -p github:knirski/auto-pr`, `bun add github:knirski/auto-pr`, or a recent release). The package ships `dist/` pre-built for Node. If developing from source (clone), run `bun run build` before use.

### "PR body file does not exist" (`pr-body.md`)

**Cause:** The generate-content step failed or didn't produce `pr-body.md` under the workspace.

**Fix:** Check the "Generate PR content" step logs. Set `AUTO_PR_DEBUG=1` in the workflow env for verbose output. Verify that generate-content wrote `pr-title.txt` and `pr-body.md` under the workspace.

## Create or update PR fails

### "Resource not accessible" or 403

**Cause:** GitHub App lacks permissions or isn't installed on the repo.

**Fix:** In the app settings, ensure **Contents** and **Pull requests** are **Read and write**. Reinstall the app on the repository.

### "Secret not found"

**Cause:** `APP_ID` or `APP_PRIVATE_KEY` not set in repository secrets.

**Fix:** Go to **Settings → Secrets and variables → Actions** and add both secrets. The private key is the full contents of the `.pem` file.

## AI provider / 2+ commits

### Connection refused or unreachable URL (provider: `local`)

**Cause:** For 2+ commits with `AUTO_PR_AI_PROVIDER=local`, auto-pr calls the OpenAI-compatible URL from `AUTO_PR_AI_OPENAI_COMPAT_URL` (default `http://127.0.0.1:8080/v1`). Nothing starts a local server for you in CI.

**Fix:** Ensure a compatible server is running and reachable from the environment (self-hosted runner, tunnel, or remote URL). On GitHub-hosted runners, prefer **`github-models`** unless you expose a reachable endpoint.

### Description is empty or "null"

**Cause:** The AI provider returned invalid or empty response. Auto-pr retries up to **five** attempts (see `MAX_AI_ATTEMPTS` in `auto-pr-generate-content.ts`) and then falls back to commit-derived title and description.

**Fix:** Check the "Generate PR content" step logs. The PR may still be created with a fallback description. For **local**, verify `AUTO_PR_AI_OPENAI_COMPAT_MODEL` and URL. For **github-models**, verify `AUTO_PR_AI_OPENAI_COMPAT_MODEL` and `GH_TOKEN`. `AUTO_PR_AI_PROVIDER` defaults to `local` when unset (see [config.ts](../src/auto-pr/config.ts)).

### GitHub Models: 401 / invalid token (provider: github-models)

**Cause:** `GH_TOKEN` is missing, expired, or lacks permission to call the GitHub Models API.

**Fix:** In CI, the stock workflow passes `github.token` when `GH_TOKEN` is unset — ensure the entry workflow has **`models: read`**. Optionally set repository secret **`GH_TOKEN`** to override. For local runs, export `GH_TOKEN` before `run-auto-pr`. See [INTEGRATION.md](INTEGRATION.md#github-models).

### GitHub Models: model not found / 404 (provider: github-models)

**Cause:** `AUTO_PR_AI_OPENAI_COMPAT_MODEL` does not match an available GitHub Models id (wrong name, deprecated, or typo).

**Fix:** Set `ai_openai_compat_model` / `AUTO_PR_AI_OPENAI_COMPAT_MODEL` to a valid catalog **`id`** (format `publisher/model`, e.g. `openai/gpt-4.1`). See [INTEGRATION.md — github-models](INTEGRATION.md#github-models) for how to fetch the current list from `https://models.github.ai/catalog/models`.

### OpenAI-compatible: connection error / URL unreachable (provider: `local`)

**Cause:** `AUTO_PR_AI_OPENAI_COMPAT_URL` is wrong, the host is down, TLS/firewall blocked the runner, or the path is not the API base your provider expects.

**Fix:** Verify the URL in a small curl or client test from the same environment (local vs CI). For Azure and similar hosts, use the exact resource base URL and deployment name via `AUTO_PR_AI_OPENAI_COMPAT_MODEL` as required by that provider.

### OpenAI-compatible: 401 / invalid API key (provider: `local`)

**Cause:** `AUTO_PR_AI_OPENAI_COMPAT_API_KEY` is empty, rotated, or incorrect for the endpoint.

**Fix:** Rotate or paste the key again in repo secrets / env. Ensure the generate job passes `ai_openai_compat_api_key` when using the reusable workflow. Keys are redacted in logs; confirm the secret name matches what the workflow forwards.

## Wrong runtime (Node vs Bun) or cache not working

**Cause:** The [setup-runtime action](../.github/actions/setup-runtime/README.md) detects your runtime from `packageManager` (in package.json) or lockfile. Stale lockfiles or missing `packageManager` can cause mismatches.

**Fix:** Ensure your repo has one of: `packageManager` in package.json (`bun@*`, `npm@*`, `pnpm@*`, `yarn@*`), or a lockfile (`bun.lock`, `bun.lockb`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`). For pnpm, `pnpm/action-setup` must run before `setup-node`; setup-runtime handles this.

## npm "Unknown user config always-auth"

**Cause:** Your `~/.npmrc` or `NPM_CONFIG_ALWAYS_AUTH` env contains `always-auth`, which npm removed in v7+.

**Fix:** Run `npm config delete always-auth` or remove it from `~/.npmrc`. This is a local config issue; CI typically has no such setting.

## Debug mode

Set `AUTO_PR_DEBUG=1` in the workflow env to get a hint when errors occur:

```yaml
env:
  AUTO_PR_DEBUG: "1"
```

For more verbose logging, add it to the job or specific steps.
