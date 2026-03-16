# auto-pr

[![CI](https://github.com/knirski/auto-pr/actions/workflows/ci.yml/badge.svg)](https://github.com/knirski/auto-pr/actions)
[![Coverage](https://codecov.io/gh/knirski/auto-pr/graph/badge.svg)](https://app.codecov.io/gh/knirski/auto-pr)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/knirski/auto-pr/badge)](https://scorecard.dev/viewer/?uri=github.com/knirski/auto-pr)
[![Version](https://img.shields.io/github/package-json/v/knirski/auto-pr)](https://github.com/knirski/auto-pr/blob/main/package.json)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/license/Apache-2.0)
[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-Support-ea4aaa.svg)](https://github.com/sponsors/knirski)
[![Liberapay](https://img.shields.io/badge/Liberapay-Support-yellow.svg)](https://liberapay.com/knirski/)
[![CII Best Practices](https://img.shields.io/badge/CII%20Best%20Practices-register-green)](https://www.bestpractices.dev/en/projects/new?project_url=https%3A%2F%2Fgithub.com%2Fknirski%2Fauto-pr)

Auto-create pull requests from conventional commits on `ai/*` branches. Parses commit messages, fills a PR template, and optionally uses [Ollama](https://ollama.com/) to generate descriptions for multi-commit PRs.

**Convention over configuration.** Run `npx auto-pr-init`, set up a GitHub App, and you're done. Defaults work for most projects; override via workflow inputs only when needed.

**Universal:** Works with any GitHub project — Node, Python, Rust, Go, etc. No `package.json` required when using the [reusable workflows](.github/workflows/auto-pr-generate-reusable.yml) (generate + create). **No Nix required** — users use Node/npx only.

**Goal:** Enable AI-assisted development workflows. When an AI agent (or developer) pushes to an `ai/`-prefixed branch, a workflow automatically creates or updates a PR with a title and body derived from conventional commits. For 2+ commits, Ollama summarizes the changes into a coherent description.

**Origin:** Extracted from [paperless-ingestion-bot](https://github.com/knirski/paperless-ingestion-bot), where it powered the auto-PR workflow for AI-generated branches. See [docs/ORIGIN.md](docs/ORIGIN.md).

## Features

- **Conventional commits** — Parses `feat:`, `fix:`, `docs:`, etc. for PR title and type
- **PR template** — Fills `.github/PULL_REQUEST_TEMPLATE.md` with description, changes, checklist
- **Ollama integration** — For 2+ commits, summarizes commit bodies into a PR description (default: `llama3.1:8b`)
- **gh CLI** — Thin wrapper around `gh pr create` / `gh pr edit`
- **CI-agnostic** — Outputs to `GITHUB_OUTPUT`; works with GitHub Actions or any orchestrator

## How it works

1. **Get commits** — `auto-pr-get-commits` runs `git log` and `git diff` to produce `commits.txt`, `files.txt`, and outputs paths to `GITHUB_OUTPUT`
2. **Generate content** — `auto-pr-generate-content` parses commits, counts semantic commits. For 1 commit: fills template from body. For 2+: calls Ollama to summarize, then fills template. Outputs `title` and `body_file` to `GITHUB_OUTPUT`
3. **Create or update PR** — `auto-pr-create-or-update-pr` runs `gh pr view` → `gh pr edit` or `gh pr create` with the title and body file

Merge commits are filtered out. Non-conventional commits are included; type falls back to "Chore".

## Quick start (user)

Add auto-pr to any repo in 6 steps:

1. **Init** — `npx auto-pr-init` (creates workflow, PR template, `.nvmrc`)
2. **Create** — [GitHub App](https://github.com/settings/apps/new) with Contents and Pull requests (Read and write)
3. **Generate** — Private key in app settings → save `.pem`
4. **Install** — Install the app on your repository
5. **Secrets** — Add `APP_ID` and `APP_PRIVATE_KEY` to **Settings → Secrets and variables → Actions**
6. **Test** — `git checkout -b ai/test && git commit --allow-empty -m "chore: test" && git push`

No `package.json` required. Full guide: [docs/INTEGRATION.md](docs/INTEGRATION.md).

## Quick start (development)

```bash
npm install
npx lefthook install
npm run check
```

| Command | Purpose |
|---------|---------|
| `npm run check` | Local checks (npm, statix, deadnix, typos, lychee, actionlint) |
| `npm run check:code` | Code only: build, audit, test, lint, knip, typecheck. Runs on pre-push. |
| `npm run check:ci` | Full CI parity in Docker (requires Docker + `gh act` or `act`) |
| `npm run check:with-links` | Full check + lychee link verification (can fail on broken external URLs) |
| `npm run check:just-links` | Lychee link check only (requires lychee or Nix) |

## Installation

**As a dependency (optional; for local runs or when pinning a version):**

```bash
npm install auto-pr
# or: npm install github:knirski/auto-pr
```

**From source:**

```bash
git clone https://github.com/knirski/auto-pr.git
cd auto-pr
npm install
npm run build
npx lefthook install
```

## Commands

| Command | Purpose |
|--------|---------|
| `npx auto-pr-get-commits` | Get commit log and changed files; output to GITHUB_OUTPUT |
| `npx auto-pr-generate-content` | Generate PR title and filled body (Ollama for 2+ commits) |
| `npx auto-pr-create-or-update-pr` | Create or update PR via `gh` |
| `npx auto-pr-fill-pr-template` | CLI for filling PR template from commits (standalone use) |
| `npx auto-pr-init` | Create workflow, PR template, and .nvmrc in current repo |

## Nix flake (contributors only, optional)

Nix is **not required for users**. The workflows use Node and npx only.

For contributors to this repo, the project includes an optional Nix flake. CI uses upstream Nix (cachix/install-nix-action) with nixpkgs pinned to `nixos-25.11`. Builds on x86_64-linux and aarch64-linux (arm64 runners). The flake provides:

| Use | Command | Purpose |
|-----|---------|---------|
| **Dev shell** | `nix develop` | Node 24, npm, statix, deadnix, typos, actionlint, lychee, shellcheck, shfmt in PATH; run `npm run check` |
| **Reproducible build** | `nix build` | Pinned, reproducible package (no network at build time) |
| **Verify flake** | `nix flake check -L` | Run all checks (statix, deadnix, build; same as CI) |
| **Local run** | `nix run .#default` | Full pipeline locally (requires `GH_TOKEN`, Ollama for 2+ commits) |
| **Update deps hash** | `nix run .#update-npm-deps-hash` | Update `npmDepsHash` in `default.nix` after changing `package-lock.json` |
| **Format Nix** | `nix fmt` | Format `*.nix` with nixfmt |
| **Run tools** | `nix run .#statix -- check .`, `nix run .#typos`, etc. | Run statix, deadnix, typos, actionlint, lychee, prefetch-npm-deps directly |

```bash
# Development shell
nix develop

# Run full pipeline (requires GH_TOKEN, Ollama for 2+ commits)
npx tsx src/workflow/run-auto-pr.ts
# or: node dist/workflow/auto-pr-run.mjs (after npm run build)
# or: nix run .#default
```

## Environment variables

When running scripts directly, all required vars must be set and non-empty. No default values; fail fast when absent.

When using the [reusable workflows](.github/workflows/auto-pr-generate-reusable.yml), `PR_TEMPLATE_PATH`, `OLLAMA_MODEL`, `OLLAMA_URL`, and `AUTO_PR_HOW_TO_TEST` are provided via workflow inputs with sensible defaults (convention over configuration).

| Variable | Required | Description |
|----------|----------|-------------|
| `DEFAULT_BRANCH` | get-commits, create-or-update-pr | Base branch (e.g. `main`) |
| `GITHUB_WORKSPACE` | get-commits, generate-content, create-or-update-pr | Repo root |
| `GITHUB_OUTPUT` | get-commits, generate-content | Output file (GitHub Actions) |
| `COMMITS` | generate-content | Path to commits.txt |
| `FILES` | generate-content | Path to files.txt |
| `PR_TEMPLATE_PATH` | generate-content | Path to PR template (default `.github/PULL_REQUEST_TEMPLATE.md`) |
| `OLLAMA_MODEL` | generate-content | Ollama model (default `llama3.1:8b`) |
| `OLLAMA_URL` | generate-content | Ollama API (default `http://localhost:11434/api/generate`) |
| `AUTO_PR_HOW_TO_TEST` | generate-content | "How to test" text (default: generic; Node projects: `auto_pr_how_to_test: "1. Run \`npm run check\`\n2. "`; Python: `"1. Run \`pytest\`\n2. "`) |
| `GH_TOKEN` | create-or-update-pr | GitHub token |
| `BRANCH` | create-or-update-pr | Current branch |
| `TITLE` | create-or-update-pr | PR title |
| `BODY_FILE` | create-or-update-pr | Path to filled body |
| `AUTO_PR_DEBUG` | any | Optional. Set to `1` for verbose error hints when debugging |

## Integration

Designed to run in CI (e.g. GitHub Actions) or locally via `run-auto-pr.ts`. See [docs/INTEGRATION.md](docs/INTEGRATION.md) for how to add auto-pr to any repository (GitHub App setup, workflow example).

This repo uses [release-please](https://github.com/googleapis/release-please) for version and changelog automation. Requires `APP_ID` and `APP_PRIVATE_KEY` secrets (GitHub App). **Supply chain:** npm audit in check; SBOM (CycloneDX via npm sbom), Dependabot, CodeQL, OpenSSF Scorecard with least-privilege workflow permissions.

## Documentation

- [docs/INTEGRATION.md](docs/INTEGRATION.md) — Integration guide (GitHub App, workflow)
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — Debugging and common issues
- [docs/PR_TEMPLATE.md](docs/PR_TEMPLATE.md) — Template placeholders and behavior
- [docs/CI.md](docs/CI.md) — Workflows, branch protection, first-time setup
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Project structure and design
- [docs/adr/](docs/adr/) — Architecture Decision Records
- [docs/ORIGIN.md](docs/ORIGIN.md) — Extraction from paperless-ingestion-bot
- [docs/CII.md](docs/CII.md) — CII Best Practices badge progress
- [AGENTS.md](AGENTS.md) — AI agent instructions
- [CONTRIBUTING.md](CONTRIBUTING.md) — Development setup, commits, PRs
- [SECURITY.md](SECURITY.md) — Vulnerability reporting
- [SUPPORT.md](SUPPORT.md) — Getting help
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — Community standards

This project was developed with assistance from AI coding tools.

## Verification

```bash
npm run check
```

Runs full check: audit, test, lint, knip, typecheck, Nix (statix, deadnix), docs (rumdl, typos), actionlint, shellcheck, shfmt. Use `check:with-links` to add lychee link verification. Pre-push runs `check:code` (npm deps only). Use `check:ci` for full CI parity in Docker.

## License

[Apache-2.0](LICENSE)
