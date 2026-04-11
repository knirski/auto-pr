# Contributing

Thanks for your interest in contributing to auto-pr.

## Development Setup

**Direct contributors** (with write access):

```bash
git clone https://github.com/knirski/auto-pr.git
cd auto-pr
bun install
bun run build
bun x lefthook install
```

**Fork contributors:** Fork the repo, clone your fork, then `bun install`, `bun run build`, and `bun x lefthook install`. Push to `ai/**` branches to auto-create PRs. The auto-PR workflow runs on forks; it will fail with "Missing secrets" unless you add `APP_ID` and `APP_PRIVATE_KEY` to your fork's **Settings → Secrets and variables → Actions** (create a GitHub App for your fork). Without secrets, create the PR manually from your branch to `main`.

### Optional: typos, lychee, and actionlint for full local check

`bun run check` runs spell check (typos), link check (lychee), and workflow lint (actionlint). These tools are not on npm; install them for your OS, or use `nix develop` (recommended — puts all tools in PATH).

Without these tools installed, `scripts/nix-run-if-missing.sh` will use `nix run .#<tool>` (flake packages) if Nix is available. Otherwise, `check:docs`, `check:just-links`, or `lint:workflows` will fail locally; CI still runs them via GitHub Actions.

#### Install without Nix (per-OS instructions)

| OS | typos | lychee | actionlint |
|----|-------|--------|------------|
| **macOS** (Homebrew) | `brew install typos-cli` | `brew install lychee` | `brew install actionlint` |
| **Linux** (Ubuntu/Debian) | [Pre-built binary](https://github.com/crate-ci/typos/releases) or `cargo install typos-cli` | [Pre-built binary](https://github.com/lycheeverse/lychee/releases) or `cargo install lychee` | [Pre-built binary](https://github.com/rhysd/actionlint/releases) |
| **Linux** (Fedora) | `dnf install typos-cli` | `cargo install lychee` | [Pre-built binary](https://github.com/rhysd/actionlint/releases) |
| **Linux** (Arch) | `pacman -S typos` | `pacman -S lychee` or `cargo install lychee` | `pacman -S actionlint` |
| **Linux** (Homebrew) | `brew install typos-cli` | `brew install lychee` | `brew install actionlint` |
| **Windows** | [Pre-built binary](https://github.com/crate-ci/typos/releases) or `cargo install typos-cli` | [Pre-built binary](https://github.com/lycheeverse/lychee/releases) or `cargo install lychee` | [Pre-built binary](https://github.com/rhysd/actionlint/releases) |

**check:just-links** and **check:with-links** can fail on broken external URLs (404s, redirects, timeouts). Use `bun run check:just-links` to verify links locally. Both check.yml and check-docs.yml run lychee with `continue-on-error: true` so link failures do not block merge. Lychee accepts 200 and 429 (rate limit) via `--accept 200,429`.

**statix and deadnix** (Nix lint): Run with `--optional`; skipped when neither tool nor Nix is available. CI still runs them via the nix job.

### Run CI locally (check job)

`bun run act` runs the **`check`** job from [ci.yml](.github/workflows/ci.yml), then the **`integration`** job from [integration.yml](.github/workflows/integration.yml), matching GitHub Actions. Requires [Docker](https://docs.docker.com/get-docker/) and either:

- **gh extension** (preferred): `gh extension install nektos/gh-act`
- **act standalone**: `brew install act` (or [other install options](https://github.com/nektos/act#installation))
- **Nix**: With Nix installed, `act` is available from this flake on **Linux and macOS** (see `flake.nix` systems). The helper runs `nix run .#act` when `act` is not on your PATH (same pattern as `scripts/nix-run-if-missing.sh`). `nix develop` also puts `act` in PATH. Without Nix, use `gh act`, Homebrew `act`, or another install.

The script prefers standalone `act` (PATH or `nix run .#act` when the flake supports your host), so you do not need `gh extension install nektos/gh-act` unless you rely on `gh act` alone. If neither `act` nor Nix is available, it uses `gh act` when that extension is installed. In code this is the **`direct`** backend (`bash` + `scripts/nix-run-if-missing.sh` + `act`) vs **`gh`** (`gh act`); see `ActBackend` in [`act-local-ci.ts`](src/core/act-local-ci.ts).

This repo’s workflows use a specific `runs-on` label (see the YAML). [act](https://github.com/nektos/act) needs **`-P <runs-on>=<container image>`** where `<runs-on>` **matches** the workflow job’s label. [scripts/act-local-ci.ts](scripts/act-local-ci.ts) defaults the label to **`ubuntu-24.04`** ([`DEFAULT_ACT_RUNS_ON_LABEL`](src/core/act-local-ci.ts)); set **`ACT_RUNS_ON_LABEL`** if your workflows use something else. It resolves a **container image** via **`ACT_RUNNER_IMAGE`** (optional) or built-in defaults tuned for this repo’s current label. Same script writes a minimal `workflow_dispatch` JSON (`-e`, from `git remote origin` or `package.json` `repository`) to `.act-artifacts/workflow_dispatch.json` so `github.event.repository` exists for actions that need it, and **`--artifact-server-path .act-artifacts/`** so [`actions/upload-artifact`](https://github.com/actions/upload-artifact) (SBOM, gitleaks SARIF) gets a local [artifact server](https://github.com/nektos/act/issues/1929) instead of GitHub’s `ACTIONS_RUNTIME_TOKEN`. If you invoke **`act` by hand**, pass **`-P`** with the same label as `runs-on` and your chosen image.

**Parity limits:** GitHub-hosted CI is still an **Azure VM**, not Docker—kernel, OIDC, and some services differ. act cannot be identical, but **matching runner image + artifact server + event file** lets the [check workflow](.github/workflows/check.yml) run the same steps locally without skipping gitleaks, SBOM upload, or rumdl.

### Unit vs integration tests

Pre-push and the CI **`check`** job run **unit tests only** (`bun test`). Integration tests under `test/integration/` are excluded by default ([`bunfig.toml`](bunfig.toml)); they need env and network.

| Command | What runs |
|---------|-----------|
| `bun test` | Unit tests only |
| `bun run check:code` | Unit tests (same as above), plus build, audit, lint, knip, typecheck |
| `bun run test:integration` | HTTP integration tests only |
| `bun run test:all` | Unit tests, then integration |
| `bun run act` | CI `check` then `integration` in Docker (not the same as `test:all`). [package.json](package.json) exposes a single **`act`** script; pass a mode after `--` (see below). |
| `bun run act -- check` | Only the CI `check` job (faster; skips integration) |
| `bun run act -- check-workflows` | Only [ci-workflows.yml](.github/workflows/ci-workflows.yml) → [check-workflows.yml](.github/workflows/check-workflows.yml) (actionlint + shellcheck on `.github`; fast). |
| `bun run act -- --dry-run check` | `act --dryrun` for [ci.yml](.github/workflows/ci.yml) → [check.yml](.github/workflows/check.yml) (validates workflow graph; not a full run). Equivalent: `bun scripts/act-local-ci.ts --dry-run check` (or `-n check`). |
| `bun run act -- --dry-run check-workflows` | `act --dryrun` for the **ci-workflows** path only. Equivalent: `bun scripts/act-local-ci.ts --dry-run check-workflows`. |
| `bun run act -- integration` | Only the `integration` workflow job (llama-server + GitHub Models) |

**GitHub Actions** runs [act-smoke.yml](.github/workflows/act-smoke.yml) on pushes/PRs that touch act-related paths: a **matrix** runs **`--dry-run check`** and **`check-workflows`** **in parallel** (each job installs [**nektos/gh-act**](https://github.com/nektos/gh-act) and [act-local-ci.ts](scripts/act-local-ci.ts); `gh act` when `act` is not on `PATH`). There is no **`--dry-run check-workflows`** because the **`check-workflows`** matrix cell covers that graph. A **smaller default container image** applies for both unless **`ACT_RUNNER_IMAGE`** is set. It does **not** replace full `check` on GitHub—optional smoke test. See [docs/CI.md](docs/CI.md#run-ci-locally) for what is intentionally out of scope.

### Pre-push hook

Lefthook runs `bun run check:code` before each push. It is installed as a devDependency; run `bun x lefthook install` after cloning to enable git hooks (no separate install required). Uses Bun for build, audit, `test:unit` (excludes `test/integration`), lint, knip, typecheck; no typos/lychee/actionlint required. Skip with `git push --no-verify` if needed.

**When changing `src/`:** Run `bun run build` before tests if needed (`check:code` does this automatically). `dist/` is gitignored—you don't commit it; the [update-dist](docs/CI.md#dist-and-gitignore) workflow builds and commits it after merge so `npx -p github:knirski/auto-pr` works for Node-only users.

If you change `bun.lock` (e.g. add a dependency), `bun.nix` must be updated:

**CI handles it:** Push your branch. CI will update `bun.nix` automatically for same-repo PRs and main. No need to commit the change yourself.

**Local warning:** `bun run check` warns when `bun.nix` is stale. You can ignore it — CI will fix it when you push.

**If CI pushes a bun.nix update:** The PR head will change. Wait 1–2 minutes for the new check to complete before merging. See [docs/CI.md](docs/CI.md#troubleshooting-check--check-waiting-for-status) if the required check stays "waiting for status".

**Fork PRs:** CI cannot push to forks. If the nix job fails (ci-nix.yml), update locally: `nix run .#update-bun-nix`, then commit and push. See [docs/CI.md](docs/CI.md).

See [README.md](README.md) for overview and [AGENTS.md](AGENTS.md) for architecture.

## Nix flake (optional)

Nix is **not required for users**. The workflows use Node and npx only.

For contributors to this repo, the project includes an optional Nix flake. CI uses upstream Nix (cachix/install-nix-action) with nixpkgs pinned to **`nixpkgs-unstable`** (via `flake.lock`). `nix flake check` runs on **x86_64-linux**, **aarch64-linux**, and **aarch64-darwin** (`macos-latest`). Intel Macs are not supported by the flake (use Homebrew or other installs from the table above).

**direnv:** With [direnv](https://direnv.net/) installed and hooked into your shell, run **`direnv allow`** once in the repo root. The committed **`.envrc`** loads the same dev environment as **`nix develop`** on supported hosts (Linux x86_64/aarch64, Apple Silicon). Optional: [nix-direnv](https://github.com/nix-community/nix-direnv) for faster reloads. Tools then stay on `PATH` when you work in the tree (see also `scripts/nix-run-if-missing.sh` for scripts that run without direnv).

The flake provides:

| Use | Command | Purpose |
|-----|---------|---------|
| **Dev shell** | `nix develop` | Bun, act, statix, deadnix, typos, actionlint, lychee, shellcheck, shfmt in PATH; run `bun run check` |
| **direnv** | `direnv allow` | Same as dev shell when you `cd` here (see `.envrc`; not on Intel Mac) |
| **Reproducible build** | `nix build` | Pinned, reproducible package (no network at build time) |
| **Verify flake** | `nix flake check -L` | Run all checks (statix, deadnix, build; same as CI) |
| **Local run** | `nix run .#default` | Full pipeline locally (requires `GH_TOKEN`, AI provider for 2+ commits) |
| **Update bun.nix** | `nix run .#update-bun-nix` | Regenerate `bun.nix` after changing `bun.lock` |
| **Format Nix** | `nix fmt` | Format `*.nix` with nixfmt |
| **Run tools** | `nix run .#statix -- check .`, `nix run .#typos`, etc. | Run statix, deadnix, typos, actionlint, lychee, bun2nix directly |

```bash
# Development shell
nix develop

# Run full pipeline (requires GH_TOKEN, AI provider for 2+ commits)
bun run src/workflow/auto-pr-run.ts
# or: node dist/workflow/auto-pr-run.js (after bun run build)
# or: nix run .#default
```

### Documentation website

The docs site lives in `website/` and is built with [Starlight](https://starlight.astro.build/) (Astro).

```bash
cd website
bun install
bun run dev      # local dev server
bun run build    # production build
```

Content is sourced from `docs/` — the copy-docs script runs automatically before each build.

## CHANGELOG.md

**Do not edit CHANGELOG.md manually.** It is auto-generated by [release-please](https://github.com/googleapis/release-please) from your commit messages when a release is cut. Write good [Conventional Commits](#commits) and the changelog will update automatically.

## Commits

All commits must follow [Conventional Commits](https://www.conventionalcommits.org/). This is enforced locally via [commitlint](https://commitlint.js.org/) (lefthook hook) and in CI.

Examples:

- `feat: add support for X`
- `fix: resolve Y when Z`
- `docs: update README`
- `chore: bump dependency`

When a change addresses an issue, include `Closes #<issue>` in the commit body so the PR template populates Related issues.

## Pull Requests

**AI-assisted workflow:** Push to `ai/**` branches to auto-create PRs with title and body from conventional commits. See [docs/INTEGRATION.md](docs/INTEGRATION.md) for setup.

- **Same-repo contributors:** Workflow runs automatically. When testing workflow changes on a new branch: (1) Prefer `bun run act` (nektos act / `gh act`) for local testing. (2) If pushing to CI, update **all** `@SHA` refs to the current commit (`git rev-parse HEAD`) — branch name refs are not allowed by the repo's pinning policy. Update: both `uses:` lines in auto-pr.yml, all composite action refs in auto-pr-generate-reusable.yml, and the setup-runtime ref in check.yml. Run `sed -i "s|@<old-sha>|@<new-sha>|g"` on the workflow files after each push. **After merging:** Pins are updated automatically by update-workflow-pins. See [docs/CI.md](docs/CI.md#workflow-pin-automation).
- **Fork contributors:** Workflow runs on your fork. Add `APP_ID` and `APP_PRIVATE_KEY` to your fork's secrets to enable auto-PR; otherwise create the PR manually.

1. Run `bun run check` before submitting.
2. Ensure your commits follow Conventional Commits (the PR template includes a checklist).
3. Update documentation if your changes affect user-facing behavior.

## Good First Issues

Issues labeled `good first issue` are suitable for newcomers: they have clear scope, acceptance criteria, and links to relevant code. If you're new to the project, start there.

## When Unsure About Approach

If you're unsure how to implement something or there are several valid options:

1. **Check official documentation first** — Use the primary source for the tool or library.
2. **Check popular public repos** — See how active, well-maintained projects handle the same problem.

## Code Style

The project uses [Biome](https://biomejs.dev/) for linting and formatting. Run `bun run lint:fix` to auto-fix issues.
