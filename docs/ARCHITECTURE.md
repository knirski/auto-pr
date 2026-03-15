# Architecture

This project uses [Effect](https://effect.website/) v4 beta and [TypeScript Native](https://devblogs.microsoft.com/typescript/announcing-typescript-native-previews/) (`tsgo`) for typecheck. No declaration emit; scripts run via tsx.

## High-Level Structure

```
┌─────────────────────────────────────────────────────────────────┐
│  CLI entry points (scripts/*.ts)                                  │
│  auto-pr-get-commits, generate-pr-content, create-or-update-pr,   │
│  fill-pr-template                                                 │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  Imperative Shell (scripts/auto-pr/shell.ts, config.ts)           │
│  Orchestrates I/O, reads env, calls core via Effect.fromResult   │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  Functional Core (scripts/auto-pr/core.ts, fill-pr-template-core) │
│  Pure functions, no Effect, no I/O, returns Result                │
└─────────────────────────────────────────────────────────────────┘
```

## Pipeline Flow

1. **get-commits** — `git log` + `git diff` → commits.txt, files.txt, GITHUB_OUTPUT
2. **generate-content** — Parse commits → 1 commit: fill from body; 2+: Ollama summarize → fill template → title, body_file
3. **create-or-update-pr** — `gh pr view` → `gh pr edit` or `gh pr create`

## Functional Core / Imperative Shell (FC/IS)

- **`scripts/*.ts`** — CLI entry points. Parse env, delegate to shell.
- **`scripts/auto-pr/shell.ts`** — Imperative shell. runCommand, appendGhOutput, runMain. Orchestrates I/O.
- **`scripts/auto-pr/config.ts`** — Schema-validated env. Config as service.
- **`scripts/auto-pr/core.ts`** — Pure helpers. filterSemanticSubjects, formatGhOutput, etc. No Effect, no I/O.
- **`scripts/fill-pr-template-core.ts`** — Pure PR template logic. parseCommits, fillTemplate, renderBody.
- **`scripts/auto-pr/interfaces/`** — Tagless Final service interfaces (FillPrTemplate).
- **`scripts/auto-pr/live/`** — Live interpreters. Implements FillPrTemplate for production.

**Bridge:** Core returns `Result`; shell calls `Effect.fromResult` at the boundary.

## Where to Start

- **Entry points:** `scripts/auto-pr-get-commits.ts`, `scripts/generate-pr-content.ts`, `scripts/create-or-update-pr.ts`, `scripts/fill-pr-template.ts`
- **Core logic:** `scripts/auto-pr/core.ts`, `scripts/fill-pr-template-core.ts`
- **Ollama integration:** `scripts/auto-pr/live/fill-pr-template.ts` (FillPrTemplate implementation)
- **Config:** `scripts/auto-pr/config.ts` — env schema and validation

## Dependency Direction

`core.ts` and `fill-pr-template-core.ts` do not depend on shell or live interpreters. Shell and live depend on core and interfaces.
