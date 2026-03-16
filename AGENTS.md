# AI Agent Instructions

auto-pr creates PRs from conventional commits on `ai/*` branches. TypeScript, Effect v4 beta, Tagless Final, FC/IS.

When editing this project, apply these rules. Workflow: apply rules → make changes → run `npm run check` → fix until pass.

## Skills

**Use the ts-scripting skill** when analyzing or editing TypeScript code. It provides canonical patterns for Effect v4, FC/IS, Tagless Final, config, testing, and guardrails. Compare against its checklist and common mistakes; apply its suggestions where applicable (some patterns like ConfigTest or TOML merge may not apply to env-only workflows).

**When to use which skill:**

| Situation | Skill |
|-----------|-------|
| Editing TypeScript | ts-scripting |
| New features, non-trivial changes | brainstorming — design before implementation |
| Before claiming completion | verification-before-completion — run `npm run check`, show output |
| Creating or editing rules | create-rule |

**For new features or non-trivial changes:** Invoke the brainstorming skill before implementation. Present design and get approval before coding.

## Research and Decision-Making

When unsure about how to implement something or when multiple approaches exist:

**Use GitHub MCP (or other relevant MCP) first when available** — Prefer MCP tools over web search or manual lookup. Fall back to web fetch or CLI only when MCP has no matching capability.

1. **Check official documentation first** — Use the primary source (library docs, GitHub Actions docs, etc.).
2. **Effect sources** — For Effect, use the LLM-oriented docs at `https://github.com/Effect-TS/effect-smol/blob/effect%404.0.0-beta.XX/LLMS.md`. Replace the version segment (`effect%404.0.0-beta.XX`) with the `effect` version from `package.json` dependencies (e.g. `4.0.0-beta.31` → `effect%404.0.0-beta.31`).
3. **When still uncertain, check popular and respectable public repos** — Look at how active, well-maintained projects handle the same problem. Mandatory when there are different valid options or no obvious solution.

## Setup

- Install: `npm install`
- Verify: `npm run check` (audit, test, lint, knip, typecheck, docs, actionlint, shellcheck, shfmt). Pre-push runs `check:code` automatically.
- **Build/typecheck:** Uses TypeScript Native (`tsgo`) for faster typecheck. No declaration emit.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run check` | Full check: test, lint, knip, typecheck, docs, actionlint, shellcheck. Run before committing. |
| `npm run check:code` | Code only: test, lint, knip, typecheck. Runs on pre-push. |
| `npm run check:ci` | Full CI parity in Docker (`gh act` or `act`). **Prefer for local workflow testing** over pushing to trigger CI. |
| `npm run check:with-links` | Full check + lychee link verification. Can fail on broken external URLs. |
| `npm run check:just-links` | Lychee link check only. Requires lychee or Nix. |
| `npm test` | Unit tests with coverage |
| `npm run lint` | Lint (Biome) |
| `npm run lint:fix` | Lint and fix |
| `npm run lint:scripts` | Shellcheck + shfmt format check |
| `npm run format:scripts` | Format shell scripts (shfmt -w) |
| `npm run typecheck` | TypeScript check |
| `npm run knip` | Unused code detection |

## Design Principles

- **Functional Core / Imperative Shell:** Core is pure (no Effect, no I/O, returns `Result`). Shell orchestrates I/O and calls core. Bridge with `Effect.fromResult` at the boundary.
- **Tagless Final:** Services are interfaces + Tags; live interpreters in `live/`, tests swap mocks. Programs declare `R`; shell provides via `Effect.provide(layer)`.
- **Effect ecosystem first:** Prefer `effect` and `@effect/*` when adding dependencies.
- **Config as service:** Workflow-specific config layers. Validate and fail early: required env vars cause immediate failure at load; no Option for required fields.
- **ADTs and pattern matching:** Prefer tagged unions over ad-hoc state; use `Match.exhaustive` for exhaustive handling.
- **Dependency direction:** `src/auto-pr/core.ts` and `src/lib/fill-pr-template-core.ts` do not depend on shell or live interpreters.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for high-level structure, pipeline flow, and FC/IS layout.

## Project Structure

```
.github/
  PULL_REQUEST_TEMPLATE.md
  workflows/         — ci, release-please, ci-release-please, auto-pr, auto-pr-generate-reusable, auto-pr-create-reusable, auto-pr-user
src/
  auto-pr/          — config, core, errors, interfaces, live, paths, shell, utils
  workflow/         — main auto-PR pipeline (get-commits, generate-content, create-or-update-pr, run-auto-pr)
  tools/            — standalone (fill-pr-template, init, update-nix-hash, update-npm-deps-hash)
  lib/              — pure core (fill-pr-template-core, collapse-prose-paragraphs, update-nix-hash-core, init-core)
scripts/             — shell scripts only (.sh)
  check-nix-hash.sh
  nix-run-if-missing.sh
  run-check-ci.sh
test/
  auto-pr/          — unit tests for src/auto-pr
  workflow/         — unit tests for src/workflow
  tools/            — unit tests for src/tools
  lib/              — unit tests for src/lib
```

## Where to Put X

| Adding… | Put in |
|---------|--------|
| Pure validation, helpers | `src/auto-pr/core.ts` or `src/lib/fill-pr-template-core.ts` |
| New config/env | `src/auto-pr/config.ts` |
| New tagged error | `src/auto-pr/errors.ts` |
| New service interface | `src/auto-pr/interfaces/` |
| New live interpreter | `src/auto-pr/live/`. Attach layer to service: `static readonly Live = Layer.effect(...)` |
| New CLI script | `src/workflow/` or `src/tools/` |
| New shell script | `scripts/` |
| New prompt | `src/auto-pr/prompts/` |

## Key Rules

| Rule | Requirement |
|------|--------------|
| Effect first | Use `effect` and `@effect/*` |
| No `any` | Use `unknown`; Biome enforces `noExplicitAny` |
| No `!` | No non-null assertions |
| No `enum` | Use string literal unions |
| No `console.log` | Use `Effect.log` |
| Core pure | No Effect, no I/O in `*-core.ts` |
| Domain errors | `Schema.TaggedErrorClass` in `errors.ts` |
| Optional returns | Use `Option<T>`; avoid `T \| null` or `T \| undefined` |
| File names | kebab-case for multi-word |
| Workflow testing | Prefer `check:ci` (act) locally; update `auto-pr.yml` SHA to `git rev-parse HEAD` when testing on new branches |

## Avoid

- I/O or Effect in `*-core.ts` — core must stay pure
- `any`, `as` type assertions — use `unknown`, Schema, or narrowing
- Forgetting `Effect.fromResult` when calling core from shell
- `console.log` — use `Effect.log`
- Logging secrets — never call `Redacted.value()` for logging

## Commits

[Conventional Commits](https://www.conventionalcommits.org/). Examples: `feat: add X`, `fix: resolve Y`, `docs: update README`, `chore: bump dependency`. Enforced by commitlint in CI.

Create small, focused commits. If changes span many files or concerns, propose splitting into separate branches or PRs.

## GitHub Operations

**Use GitHub MCP first.** Check `mcps/user-github/tools/` before using `gh` CLI.

- PRs: `create_pull_request`, `update_pull_request`, `merge_pull_request`, `pull_request_read`
- Issues: `issue_write`, `add_issue_comment`, `issue_read`
- Fallback to `gh` only when MCP has no matching tool.

## Verification

```bash
npm run check
```

Runs: check-nix-hash, check:code (audit, test, lint, knip, typecheck), check:docs (rumdl, typos), lint:workflows (actionlint), lint:scripts (shellcheck, shfmt). **Do not finish until all pass.**

- Add or update tests for the code you change, even if nobody asked.
- **Coverage policy:** Current coverage (~85%) meets thresholds. Do not chase coverage for its own sake. Add tests when: fixing a bug (add a regression test), adding a feature, or changing risky code. Skip tests for trivial branches, CLI entry points, or code that would require heavy mocking for little benefit.
- Before committing: run `npm run check`; ensure all tests pass.
- Pre-push runs `check:code` automatically (Lefthook). Use `git push --no-verify` only when necessary.
- For full CI parity locally (e.g. debugging CI): `npm run check:ci` (requires Docker + act or gh-act).
- **Workflow testing:** Prefer `npm run check:ci` (act) for local workflow testing over pushing to trigger CI. When creating a new branch to test workflow changes, update the SHA in `.github/workflows/auto-pr.yml` to the current commit (`git rev-parse HEAD`) so the workflow runs with the branch code.

## Documentation

- [docs/PR_TEMPLATE.md](docs/PR_TEMPLATE.md) — Template placeholders and fill-pr-template CLI
- [docs/INTEGRATION.md](docs/INTEGRATION.md) — How to add auto-pr to any repo
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — Debugging and common issues
- [docs/ORIGIN.md](docs/ORIGIN.md) — Extraction from paperless-ingestion-bot
- [docs/CI.md](docs/CI.md) — Workflows, branch protection, fork PRs
- [docs/WORKFLOW_SECURITY.md](docs/WORKFLOW_SECURITY.md) — Auto-PR workflow security model (two-phase, CWE-829)
- [docs/CII.md](docs/CII.md) — CII Best Practices badge progress
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Project structure and design
- [docs/adr/](docs/adr/) — Architecture Decision Records. See ADR workflow below.
- [CONTRIBUTING.md](CONTRIBUTING.md) — CHANGELOG is auto-generated by release-please; do not edit manually

## ADR Workflow

**When creating or updating an ADR:**

1. Add or update the ADR in `docs/adr/` using the [template](docs/adr/adr-template.md).
2. Update this AGENTS.md if the decision affects agent instructions: add to "Where to Put X" or Key Rules as appropriate.
3. Update [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) if the decision changes high-level structure or flows.

**When making a significant architectural change (or planning one):**

1. Follow [Research and Decision-Making](#research-and-decision-making): check official docs, then how popular repos handle similar decisions.
2. Create or update an ADR in `docs/adr/` documenting the decision, context, alternatives, and consequences.
3. Update AGENTS.md and ARCHITECTURE.md as above.

**Significant** means: affects multiple modules, is hard to reverse, changes design principles, or introduces new patterns. Minor refactors or dependency bumps do not require ADRs.
