# Troubleshooting

## Do I need Nix?

**No.** Nix is optional and only used by contributors to the auto-pr repo. Users use Node and npx only. The reusable workflow and npm dependency work without Nix.

## Workflow fails immediately

### "workflow was not found" or "failed to fetch workflow"

**Cause:** The reusable workflow is pinned to a commit SHA. If that SHA doesn't exist in the repo (e.g. force-pushed history, or testing on a branch), GitHub can't fetch it.

**Fix:**

- **Adopters:** Run `npx auto-pr-init` to get the latest workflow, or copy [auto-pr.yml](../.github/workflows/auto-pr.yml) from the main branch and use the SHA from its `uses:` lines.
- **Contributors to auto-pr:** When testing workflow changes on a branch, update both `uses:` refs in [auto-pr.yml](../.github/workflows/auto-pr.yml) to the current commit: `git rev-parse HEAD`. After merging to main, update the pin to the merge commit SHA.

### "Missing .github/PULL_REQUEST_TEMPLATE.md" (or custom path)

**Cause:** The PR template is required for auto-pr to fill the body. The error shows the path from the workflow (default `.github/PULL_REQUEST_TEMPLATE.md`, or your `pr_template_path` override).

**Fix:** Run `npx auto-pr-init` in your repo, or copy [.github/PULL_REQUEST_TEMPLATE.md](../.github/PULL_REQUEST_TEMPLATE.md) to the path shown in the error.

### "Missing secrets APP_ID or APP_PRIVATE_KEY"

**Cause:** The workflow needs a GitHub App token to create PRs.

**Fix:** Create a GitHub App (see [INTEGRATION.md](INTEGRATION.md#step-2-create-the-github-app)), install it on your repo, and add `APP_ID` and `APP_PRIVATE_KEY` to repository secrets.

**Fork contributors:** The workflow runs on forks. To test auto-PR on your fork, add the same secrets to your fork's **Settings → Secrets and variables → Actions** (create a GitHub App for your fork). Otherwise, create the PR manually from your branch to the upstream repo.

### "Missing required env: DEFAULT_BRANCH, GITHUB_OUTPUT, ..."

**Cause:** The script expects certain environment variables (usually set by GitHub Actions).

**Fix:** Ensure you're running in a GitHub Actions workflow. If running locally, set the env vars. See [README.md](../README.md#environment-variables).

## Get commits / Generate content fails

### "No semantic commits" or "PR title is empty"

**Cause:** All commits are merge commits, or no commits match conventional format.

**Fix:** Add at least one conventional commit (e.g. `feat: add X`, `fix: resolve Y`). Merge commits are filtered out. See [Conventional Commits](https://www.conventionalcommits.org/).

### "pr-description.txt: NotFound" or "FileSystem.readFile .../dist/prompts/pr-description.txt"

**Cause:** The prompt file is missing from the installed package. The package ships `dist/prompts/pr-description.txt`; if you're on an old version or a broken install, it may be absent.

**Fix:** Use the latest auto-pr (e.g. `npx -p github:knirski/auto-pr` or a recent release). If building from source, run `bun run build` before use.

### "BODY_FILE does not exist"

**Cause:** The generate-content step failed or didn't produce output.

**Fix:** Check the "Generate PR content" step logs. Set `AUTO_PR_DEBUG=1` in the workflow env for verbose output. Ensure `COMMITS` and `FILES` paths from the previous step are correct.

## Create or update PR fails

### "Resource not accessible" or 403

**Cause:** GitHub App lacks permissions or isn't installed on the repo.

**Fix:** In the app settings, ensure **Contents** and **Pull requests** are **Read and write**. Reinstall the app on the repository.

### "Secret not found"

**Cause:** `APP_ID` or `APP_PRIVATE_KEY` not set in repository secrets.

**Fix:** Go to **Settings → Secrets and variables → Actions** and add both secrets. The private key is the full contents of the `.pem` file.

## Ollama / 2+ commits

### "Ollama HTTP 404" or connection refused

**Cause:** For 2+ commits, auto-pr uses Ollama to generate the description. The workflow installs Ollama via `ai-action/setup-ollama`.

**Fix:** The action should install Ollama. If it fails, check the "Setup Ollama" step. Ensure `OLLAMA_URL` is set (e.g. `http://localhost:11434/api/generate` — in CI, Ollama runs on the runner).

### Description is empty or "null"

**Cause:** Ollama returned invalid or empty response. Auto-pr retries 3× and falls back to concatenated commit bodies.

**Fix:** Check the "Generate PR content" step logs. The PR may still be created with a fallback description. Try a different `OLLAMA_MODEL` (e.g. `llama3.1:8b`).

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
