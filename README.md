# auto-pr

[![CI](https://github.com/knirski/auto-pr/actions/workflows/ci.yml/badge.svg)](https://github.com/knirski/auto-pr/actions)
[![Coverage](https://codecov.io/gh/knirski/auto-pr/graph/badge.svg)](https://app.codecov.io/gh/knirski/auto-pr)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/knirski/auto-pr/badge)](https://scorecard.dev/viewer/?uri=github.com/knirski/auto-pr)
[![Version](https://img.shields.io/github/package-json/v/knirski/auto-pr)](https://github.com/knirski/auto-pr/blob/main/package.json)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/license/Apache-2.0)
[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-Support-ea4aaa.svg)](https://github.com/sponsors/knirski)
[![Liberapay](https://img.shields.io/badge/Liberapay-Support-yellow.svg)](https://liberapay.com/knirski/)
[![CII Best Practices](https://img.shields.io/badge/CII%20Best%20Practices-register-green)](https://www.bestpractices.dev/en/projects/new?project_url=https%3A%2F%2Fgithub.com%2Fknirski%2Fauto-pr)

Auto-create pull requests from conventional commits on `ai/*` branches. Parses commit messages, fills a PR template, and optionally uses an AI provider (GitHub Models by default in CI; local OpenAI-compatible servers for self-hosted or dev) to generate descriptions for multi-commit PRs.

**Convention over configuration.** Run `npx -p github:knirski/auto-pr auto-pr-init`, set up a GitHub App, and you're done — most adopters only use GitHub Actions and do not add this package to `package.json` unless they want the CLIs locally. Defaults work for most projects; override via workflow inputs only when needed.

**Universal:** Works with any GitHub project — Node, Python, Rust, Go, etc. No `package.json` required when using the [reusable workflows](.github/workflows/auto-pr-generate-reusable.yml) (generate + create). No action copying—workflows fetch everything from knirski/auto-pr. **No Nix required** — users use Node/npx only.

**Goal:** Enable AI-assisted development workflows. When an AI agent (or developer) pushes to an `ai/`-prefixed branch, a workflow automatically creates or updates a PR with a title and body derived from conventional commits. For 2+ commits, the AI provider summarizes the changes into a coherent description.

**Origin:** Extracted from [paperless-ingestion-bot](https://github.com/knirski/paperless-ingestion-bot), where it powered the auto-PR workflow for AI-generated branches. See [docs/ORIGIN.md](docs/ORIGIN.md).

## Features

- **Conventional commits** — Parses `feat:`, `fix:`, `docs:`, etc. for PR title and type
- **PR template** — Fills `.github/PULL_REQUEST_TEMPLATE.md` with description, changes, checklist
- **AI integration** — For 2+ commits, summarizes commit bodies into a PR description via **local** (OpenAI-compatible HTTP, e.g. llama.cpp) or **github-models**
- **gh CLI** — Thin wrapper around `gh pr create` / `gh pr edit`
- **CI-agnostic** — **get-commits** appends paths and count to `GITHUB_OUTPUT`; **generate-content** writes `pr-title.txt` and `pr-body.md` under the workspace. Works with GitHub Actions or any orchestrator that sets the same env conventions.

## How it works

1. **Get commits** — `auto-pr-get-commits` runs `git log` and `git diff` to produce `commits.txt`, `files.txt`, and outputs paths to `GITHUB_OUTPUT`
2. **Generate content** — `auto-pr-generate-content` parses commits, counts semantic commits. For 1 commit: fills template from body. For 2+: calls the AI provider to summarize, then fills template. Writes `pr-title.txt` and `pr-body.md` under `{GITHUB_WORKSPACE}`
3. **Create or update PR** — `auto-pr-create-or-update-pr` reads those files, then runs `gh pr view` → `gh pr edit` or `gh pr create`

Merge commits are filtered out. Non-conventional commits are included; type falls back to "Chore".

## Quick start (user)

Add auto-pr to any repo in 6 steps:

1. **Init** — `npx -p github:knirski/auto-pr auto-pr-init` (creates workflow, PR template, and `.nvmrc`)
2. **Create** — [GitHub App](https://github.com/settings/apps/new) with Contents and Pull requests (Read and write)
3. **Generate** — Private key in app settings → save `.pem`
4. **Install** — Install the app on your repository
5. **Secrets** — Add `APP_ID` and `APP_PRIVATE_KEY` to **Settings → Secrets and variables → Actions**
6. **Test** — `git checkout -b ai/test && git commit --allow-empty -m "chore: test" && git push`

No `package.json` required. Full guide: [docs/INTEGRATION.md](docs/INTEGRATION.md).

## Quick start (development)

```bash
bun install
bun x lefthook install
bun run check
```

For local runs of workflow CLIs or `run-auto-pr`, copy `.env.example` to `.env` and set variables. The authoritative list is the environment table at the top of [`src/auto-pr/config.ts`](src/auto-pr/config.ts).

| Command | Purpose |
|---------|---------|
| `bun run check` | Local checks (Bun, statix, deadnix, typos, lychee, actionlint) |
| `bun run check:code` | Code only: build, audit, test, lint, knip, typecheck. Runs on pre-push. |
| `bun run check:ci` | Full CI parity in Docker (requires Docker + `gh act` or `act`) |
| `bun run check:with-links` | Full check + lychee link verification (can fail on broken external URLs) |
| `bun run check:just-links` | Lychee link check only (requires lychee or Nix) |

## Installation

**Normal setup does not use this section.** Follow [Quick start (user)](#quick-start-user): Actions runs everything; you do not add auto-pr to `package.json` unless you choose to.

**Optional — add as a dependency** (local CLI runs, pinning a version, or scripting):

```bash
npm install github:knirski/auto-pr
# or: bun add github:knirski/auto-pr
```

Install from GitHub; the package is not published to npm. `dist/` is pre-built and committed by CI (see [docs/CI.md](docs/CI.md#dist-and-gitignore)). With Bun, `prepare` also builds it on install. No manual build needed.

**From source (contributors):**

```bash
git clone https://github.com/knirski/auto-pr.git
cd auto-pr
bun install
bun run build
bun x lefthook install
```

## Commands

| Command | Purpose |
|--------|---------|
| `npx auto-pr-get-commits` | Get commit log and changed files; append `commits`, `files`, `count` to `GITHUB_OUTPUT` |
| `npx auto-pr-generate-content` | Generate PR title and filled body (AI for 2+ commits) |
| `npx auto-pr-create-or-update-pr` | Create or update PR via `gh` |
| `npx auto-pr-fill-pr-template` | CLI for filling PR template from commits (standalone use) |
| `npx auto-pr-init` | Create workflow, PR template, and .nvmrc in current repo |

After install, or for one-offs: `npx -p github:knirski/auto-pr <command>`. CI runs the same bins via reusable workflows without a repo dependency.

## Nix flake (contributors only, optional)

Nix is **not required for users**. The workflows use Node and npx only.

For contributors to this repo, the project includes an optional Nix flake. CI uses upstream Nix (cachix/install-nix-action) with nixpkgs pinned to `nixos-25.11`. Builds on x86_64-linux and aarch64-linux (arm64 runners). The flake provides:

| Use | Command | Purpose |
|-----|---------|---------|
| **Dev shell** | `nix develop` | Bun, statix, deadnix, typos, actionlint, lychee, shellcheck, shfmt in PATH; run `bun run check` |
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

## Environment variables

When running scripts directly, all required vars must be set and non-empty. No default values; fail fast when absent.

When using the [reusable workflows](.github/workflows/auto-pr-generate-reusable.yml), `AUTO_PR_AI_PROVIDER` and provider-specific model settings are passed via workflow inputs with sensible defaults (convention over configuration). Authoritative schema: [src/auto-pr/config.ts](src/auto-pr/config.ts).

**Convention (not env):** `get-commits` writes `commits.txt` and `files.txt` under `{GITHUB_WORKSPACE}`; `generate-content` reads those paths and writes `pr-title.txt` and `pr-body.md`. `create-or-update-pr` reads those two files under `{GITHUB_WORKSPACE}`. PR template: `{GITHUB_WORKSPACE}/.github/PULL_REQUEST_TEMPLATE.md`. Edit **How to test** in that file for project-specific instructions.

| Variable | Required | Description |
|----------|----------|-------------|
| `DEFAULT_BRANCH` | get-commits, create-or-update-pr | Base branch (e.g. `main`) |
| `GITHUB_WORKSPACE` | get-commits, generate-content, create-or-update-pr | Repo root |
| `GITHUB_OUTPUT` | get-commits | Output file (GitHub Actions) |
| `AUTO_PR_AI_PROVIDER` | generate-content | AI provider (optional; default `local`): `local` or `github-models` |
| `AUTO_PR_AI_OPENAI_COMPAT_URL` | generate-content | **local** — OpenAI-compatible API base URL (default `http://127.0.0.1:8080/v1`; e.g. llama.cpp `llama-server`) |
| `AUTO_PR_AI_OPENAI_COMPAT_API_KEY` | generate-content | **local** — optional API key for that endpoint |
| `AUTO_PR_AI_OPENAI_COMPAT_MODEL` | generate-content | Model id: **local** defaults to `gpt-oss` when unset; **github-models** defaults to `openai/gpt-4.1` when unset |
| `GH_TOKEN` | create-or-update-pr; generate-content (github-models) | GitHub token for PR create/update; for **GitHub Models**, also used as the API credential when `AUTO_PR_AI_PROVIDER` is `github-models` |
| `BRANCH` | create-or-update-pr | Current branch |
| `AUTO_PR_DEBUG` | any | Optional. Set to `1` for verbose error hints when debugging |

## Integration

Designed to run in CI (e.g. GitHub Actions) or locally via `auto-pr-run.ts`. See [docs/INTEGRATION.md](docs/INTEGRATION.md) for how to add auto-pr to any repository (GitHub App setup, workflow example).

This repo uses [release-please](https://github.com/googleapis/release-please) for version and changelog automation. Requires `APP_ID` and `APP_PRIVATE_KEY` secrets (GitHub App). **Supply chain:** bun audit in check; SBOM (CycloneDX via native npm sbom), Dependabot, CodeQL, OpenSSF Scorecard with least-privilege workflow permissions.

## Documentation

- [docs/](docs/) — Documentation index
- [docs/INTEGRATION.md](docs/INTEGRATION.md) — Integration guide (GitHub App, workflow)
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — Debugging and common issues
- [docs/PR_TEMPLATE.md](docs/PR_TEMPLATE.md) — Template placeholders and behavior
- [docs/CI.md](docs/CI.md) — Workflows, branch protection, first-time setup
- [.github/actions/setup-runtime/README.md](.github/actions/setup-runtime/README.md) — Runtime detection (contributors)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Project structure and design
- [docs/CONCEPTS.md](docs/CONCEPTS.md) — Glossary (FC/IS, Tagless Final, etc.)
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
bun run check
```

Runs full check: audit, test, lint, knip, typecheck, Nix (statix, deadnix), docs (rumdl, typos), actionlint, shellcheck, shfmt. Use `check:with-links` to add lychee link verification. Pre-push runs `check:code` (Bun deps only). Use `check:ci` for full CI parity in Docker.

## License

[Apache-2.0](LICENSE)
