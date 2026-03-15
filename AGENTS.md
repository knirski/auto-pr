# AI Agent Instructions

auto-pr creates PRs from conventional commits on `ai/*` branches. TypeScript, Effect v4 beta, Tagless Final, FC/IS.

When editing this project, apply these rules. Workflow: apply rules → make changes → run `npm run check` → fix until pass.

## Research and Decision-Making

When unsure about how to implement something or when multiple approaches exist:

**Use GitHub MCP (or other relevant MCP) first when available** — Prefer MCP tools over web search or manual lookup. Fall back to web fetch or CLI only when MCP has no matching capability.

1. **Check official documentation first** — Use the primary source (library docs, GitHub Actions docs, etc.).
2. **When still uncertain, check popular and respectable public repos** — Look at how active, well-maintained projects handle the same problem. Mandatory when there are different valid options or no obvious solution.

## Setup

- Install: `npm install`
- Verify: `npm run check` (test, lint, knip, typecheck)
- **Build/typecheck:** Uses TypeScript Native (`tsgo`) for faster typecheck. No declaration emit.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run check` | Full check: test, lint, knip, typecheck, docs. Run before committing. |
| `npm run check:code` | Code only: test, lint, knip, typecheck. |
| `npm test` | Unit tests with coverage |
| `npm run lint` | Lint (Biome) |
| `npm run lint:fix` | Lint and fix |
| `npm run typecheck` | TypeScript check |
| `npm run knip` | Unused code detection |

## Design Principles

- **Functional Core / Imperative Shell:** Core is pure (no Effect, no I/O, returns `Result`). Shell orchestrates I/O and calls core. Bridge with `Effect.fromResult` at the boundary.
- **Tagless Final:** Services are interfaces + Tags; live interpreters in `live/`, tests swap mocks. Programs declare `R`; shell provides via `Effect.provide(layer)`.
- **Effect ecosystem first:** Prefer `effect` and `@effect/*` when adding dependencies.
- **Config as service:** Schema-validated env; pipelines `yield* Config`; core takes plain args.
- **ADTs and pattern matching:** Prefer tagged unions over ad-hoc state; use `Match.exhaustive` for exhaustive handling.
- **Dependency direction:** `scripts/auto-pr/core.ts` and `scripts/fill-pr-template-core.ts` do not depend on shell or live interpreters.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for high-level structure, pipeline flow, and FC/IS layout.

## Project Structure

```
.github/
  PULL_REQUEST_TEMPLATE.md
  workflows/         — ci, release-please, ci-release-please, auto-pr-reusable, auto-pr-consumer*
scripts/
  auto-pr/          — config, core, errors, interfaces, live, prompts, shell, utils
  fill-pr-template-core.ts
  fill-pr-template.ts
  auto-pr-get-commits.ts
  generate-pr-content.ts
  create-or-update-pr.ts
  collapse-prose-paragraphs.ts
  run-auto-pr.sh
test/
  *.test.ts          — Unit tests
```

## Where to Put X

| Adding… | Put in |
|---------|--------|
| Pure validation, helpers | `scripts/auto-pr/core.ts` or `scripts/fill-pr-template-core.ts` |
| New config/env | `scripts/auto-pr/config.ts` |
| New tagged error | `scripts/auto-pr/errors.ts` |
| New service interface | `scripts/auto-pr/interfaces/` |
| New live interpreter | `scripts/auto-pr/live/` |
| New CLI script | `scripts/` |
| New prompt | `scripts/auto-pr/prompts/` |

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

Runs: check-nix-hash, check:code (audit, test, lint, knip, typecheck), check:docs (rumdl, typos), lint:workflows (actionlint), lint:scripts (shellcheck). **Do not finish until all pass.**

- Add or update tests for the code you change, even if nobody asked.
- Before committing: run `npm run check`; ensure all tests pass.

## Documentation

- [docs/PR_TEMPLATE.md](docs/PR_TEMPLATE.md) — Template placeholders and fill-pr-template CLI
- [docs/INTEGRATION.md](docs/INTEGRATION.md) — How to add auto-pr to any repo
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — Debugging and common issues
- [docs/ORIGIN.md](docs/ORIGIN.md) — Extraction from paperless-ingestion-bot
- [docs/CI.md](docs/CI.md) — Workflows, branch protection, fork PRs
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
