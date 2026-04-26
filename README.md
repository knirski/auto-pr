# auto-pr

[![CI](https://github.com/knirski/auto-pr/actions/workflows/ci.yml/badge.svg)](https://github.com/knirski/auto-pr/actions)
[![Coverage](https://codecov.io/gh/knirski/auto-pr/graph/badge.svg)](https://app.codecov.io/gh/knirski/auto-pr)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/knirski/auto-pr/badge)](https://scorecard.dev/viewer/?uri=github.com/knirski/auto-pr)
[![Version](https://img.shields.io/github/package-json/v/knirski/auto-pr)](https://github.com/knirski/auto-pr/blob/main/package.json)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/license/Apache-2.0)
[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-Support-ea4aaa.svg)](https://github.com/sponsors/knirski)
[![Liberapay](https://img.shields.io/badge/Liberapay-Support-yellow.svg)](https://liberapay.com/knirski/)
[![CII Best Practices](https://img.shields.io/badge/CII%20Best%20Practices-register-green)](https://www.bestpractices.dev/en/projects/new?project_url=https%3A%2F%2Fgithub.com%2Fknirski%2Fauto-pr)

Auto-create pull requests from conventional commits on `ai/**` branches. Parses commit messages, fills a PR template, and optionally uses an AI provider (GitHub Models by default in CI; local OpenAI-compatible servers for self-hosted or dev) to generate descriptions for multi-commit PRs.

**Convention over configuration.** Run `npx -p github:knirski/auto-pr auto-pr-init`, set up a GitHub App, and you're done — most adopters only use GitHub Actions and do not add this package to `package.json` unless they want the CLIs locally. Defaults work for most projects; override via workflow inputs only when needed.

**Universal:** Works with any GitHub project — Node, Python, Rust, Go, etc. No `package.json` required when using the [reusable workflows](.github/workflows/auto-pr-generate-reusable.yml) (generate + create). No action copying — workflows fetch everything from knirski/auto-pr.

**Goal:** Enable AI-assisted development workflows. When an AI agent (or developer) pushes to an `ai/`-prefixed branch, a workflow automatically creates or updates a PR with a title and body derived from conventional commits. For 2+ commits, the AI provider summarizes the changes into a coherent description.

## Table of contents

- [Features](#features)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Documentation](#documentation)
- [License](#license)

## Features

- **Conventional commits** — Parses `feat:`, `fix:`, `docs:`, etc. for PR title and type
- **PR template** — Fills `.github/PULL_REQUEST_TEMPLATE.md` with description, changes, checklist
- **AI integration** — For 2+ commits, summarizes commit bodies into a PR description via **local** (OpenAI-compatible HTTP, e.g. llama.cpp) or **github-models**
- **gh CLI** — Thin wrapper around `gh pr create` / `gh pr edit`
- **CI-agnostic** — **generate-content** reads git state in the workspace and writes `pr-title.txt` and `pr-body.md`; **create-or-update-pr** reads those files and runs `gh`. Works with GitHub Actions or any orchestrator that sets the same env conventions.

## How it works

1. **Generate content** — `auto-pr-generate-content` uses git in the workspace (`git log`, diffs as needed), parses commits, and counts semantic (non-merge) commits. For one commit: fills the PR template from the commit body. For two or more: calls the AI provider to summarize, then fills the template. Writes `pr-title.txt` and `pr-body.md` under `{GITHUB_WORKSPACE}`.
2. **Create or update PR** — `auto-pr-create-or-update-pr` reads those files, then runs `gh pr view` → `gh pr edit` or `gh pr create`.

For local runs, `auto-pr-run` orchestrates generate → create with the same env contract.

Merge commits are filtered out. Non-conventional commits are included; type falls back to "Chore".

## Quick start

### Users (adopters)

Add auto-pr to any repo in 6 steps:

1. **Init** — `npx -p github:knirski/auto-pr auto-pr-init` (creates workflow, PR template, and `.nvmrc`)
2. **Create** — [GitHub App](https://github.com/settings/apps/new) with Contents and Pull requests (Read and write)
3. **Generate** — Private key in app settings → save `.pem`
4. **Install** — Install the app on your repository
5. **Secrets** — Add `APP_ID` and `APP_PRIVATE_KEY` to **Settings → Secrets and variables → Actions**
6. **Test** — `git checkout -b ai/test && git commit --allow-empty -m "chore: test" && git push -u origin HEAD`

No `package.json` required. Full guide: [docs/INTEGRATION.md](docs/INTEGRATION.md).

### Contributors

```bash
bun install
bun x lefthook install
bun run check
```

For local runs of workflow CLIs or `run-auto-pr`, copy `.env.example` to `.env` and set variables. The authoritative list is the environment table at the top of [`src/auto-pr/config.ts`](src/auto-pr/config.ts).

**Integration tests** (`bun run test:integration`) load committed [`.env.ci`](.env.ci) plus an optional gitignored `.env.local` for overrides (see [docs/CI.md](docs/CI.md#integration-tests) and [CONTRIBUTING.md](CONTRIBUTING.md#integration-test-env-this-repository)).

| Command | Purpose |
|---------|---------|
| `bun run check` | Local required checks: Nix lint, build, audit, unit tests, Biome, knip, typecheck, markdown lint, typos, actionlint, shellcheck/shfmt |
| `bun run check:code` | Code only: build, audit, **unit** tests, lint, knip, typecheck. Runs on pre-push (no integration). |
| `bun run test:integration` | HTTP integration tests: `.env.ci` + optional `.env.local`; Docker + `GH_TOKEN` as needed — see [docs/CI.md](docs/CI.md#integration-tests) |
| `bun run test:all` | `bun test` then `test:integration` |
| `bun run act` | `check` + `integration` jobs in Docker (`gh act` or nektos `act`; with Nix, `nix run .#act` on supported platforms — see [CONTRIBUTING.md](CONTRIBUTING.md)) |
| `bun run act -- check` / `bun run act -- integration` | Only CI `check`, or only `integration` — see [CONTRIBUTING.md](CONTRIBUTING.md#run-ci-locally-check-job) |
| `bun run check:with-links` | Full check + lychee link verification (can fail on broken external URLs) |
| `bun run check:just-links` | Lychee link check only (requires lychee or Nix) |

See [CONTRIBUTING.md](CONTRIBUTING.md) for full setup, Nix flake, and pre-push hooks.

## Commands

| Command | Purpose |
|--------|---------|
| `npx auto-pr-generate-content` | Generate PR title and filled body (AI for 2+ commits) |
| `npx auto-pr-create-or-update-pr` | Create or update PR via `gh` |
| `npx auto-pr-run` | Run generate → create with the same env contract |
| `npx auto-pr-fill-pr-template` | CLI for filling PR template from commits (standalone use) |
| `npx auto-pr-init` | Create workflow, PR template, and .nvmrc in current repo |

After install, or for one-offs: `npx -p github:knirski/auto-pr <command>`. CI runs the same bins via reusable workflows without a repo dependency.

## Documentation

Full documentation is available at [knirski.github.io/auto-pr](https://knirski.github.io/auto-pr/).

| Audience | Documents |
|----------|-----------|
| **Users** | [Integration guide](docs/INTEGRATION.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [PR template](docs/PR_TEMPLATE.md) |
| **Contributors** | [Architecture](docs/ARCHITECTURE.md) · [CI & workflows](docs/CI.md) · [Contributing](CONTRIBUTING.md) · [Workflow security](docs/WORKFLOW_SECURITY.md) |
| **Decisions** | [Architecture Decision Records](docs/adr/) |
| **Project** | [Security](SECURITY.md) · [Support](SUPPORT.md) · [Code of Conduct](CODE_OF_CONDUCT.md) · [CII badge progress](docs/CII.md) |

Full index: [docs/README.md](docs/)

This project was developed with assistance from AI coding tools.

## License

[Apache-2.0](LICENSE)
