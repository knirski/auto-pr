# Bun as Package Manager and Test Runner

## Context and Problem Statement

auto-pr initially used npm (extracted from paperless-ingestion-bot). The project runs TypeScript workflows and tools in CI and locally. How should we manage dependencies and run tests to balance speed, ecosystem compatibility, and simplicity?

**Problem:** Which package manager and runtime should we use for installs, scripts, and tests?

## Considered Options

* **npm** — Ubiquitous, works with `npx -p github:...` installs. Slower installs; no built-in TypeScript runner.
* **pnpm** — Fast, disk-efficient. Less common for GitHub-action consumers; `npx` compatibility varies.
* **Yarn** — Popular. Similar trade-offs to npm.
* **Bun** — Fast installs and test runs, native TypeScript execution, built-in test runner (Vitest-compatible). Less universal than Node for consumers; GitHub Actions can install Bun.
* **Keep npm, use tsx for scripts** — npm for deps; tsx for running TS. Works but adds tsx dependency and slower startup.

## Decision Outcome

Chosen option: **"Bun"**, because it provides fast installs, native TypeScript execution without extra tooling, and a built-in test runner that reduces dependencies. The workflow uses `oven-sh/setup-bun`; consumers installing via `npx -p github:knirski/auto-pr` use Node with pre-built `dist/` (no Bun required). Local dev and CI use Bun for speed.

### Consequences

* Good: Fast `bun install` and `bun test`; no tsx or separate test runner for basic runs.
* Good: Vitest used for tests (Bun-compatible); coverage, mocking, and assertions via Vitest.
* Good: `bun run check` and `bun run check:code` are the primary verification commands.
* Good: Node-only consumers (npx, npm install) use `dist/` built by CI; no Bun dependency at consume time.
* Bad: Contributors need Bun for full local parity; docs and Lefthook assume Bun.
* Note: Nix uses bun2nix for `bun.nix`; `update-bun-nix` and ci-nix keep it in sync.

## References

* [CI.md](../CI.md) — Workflow setup, check commands
* Git: `bb66629 feat: migrate to Bun package manager and test runner (#14)`
