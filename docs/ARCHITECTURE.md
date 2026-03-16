# Architecture

This project uses [Effect](https://effect.website/) v4 beta and [TypeScript Native](https://devblogs.microsoft.com/typescript/announcing-typescript-native-previews/) (`tsgo`) for typecheck. tsdown builds `dist/`; scripts run via `node dist/`. No declaration emit.

## High-Level Structure

```
┌─────────────────────────────────────────────────────────────────┐
│  CLI entry points (src/workflow/*.ts, src/tools/*.ts)           │
│  workflow: auto-pr-get-commits, generate-pr-content,             │
│  create-or-update-pr, run-auto-pr                               │
│  tools: fill-pr-template, init, update-nix-hash                 │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  Imperative Shell (src/auto-pr/shell.ts, config.ts)             │
│  Orchestrates I/O, reads env, calls core via Effect.fromResult  │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  Functional Core (src/auto-pr/core.ts, src/lib/*.ts)             │
│  Pure functions, no Effect, no I/O, returns Result              │
└─────────────────────────────────────────────────────────────────┘
```

## Pipeline Flow

1. **get-commits** — `git log` + `git diff` → commits.txt, files.txt, GITHUB_OUTPUT
2. **generate-content** — Parse commits → 1 commit: fill from body; 2+: Ollama summarize → fill template → title, body_file
3. **create-or-update-pr** — `gh pr view` → `gh pr edit` or `gh pr create`

## Functional Core / Imperative Shell (FC/IS)

- **`src/workflow/*.ts`** — Main auto-PR workflow. get-commits, generate-content, create-or-update-pr, run-auto-pr.
- **`src/tools/*.ts`** — Standalone tools. fill-pr-template, init, update-nix-hash, update-npm-deps-hash.
- **`src/lib/*.ts`** — Pure core modules. fill-pr-template-core, collapse-prose-paragraphs.
- **`src/auto-pr/shell.ts`** — Imperative shell. runCommand, appendGhOutput, runMain. Orchestrates I/O.
- **`src/auto-pr/paths.ts`** — Path resolution for package-relative assets (e.g. getPrDescriptionPromptPath).
- **`src/auto-pr/config.ts`** — Workflow-specific config layers. Validate and fail early: required env vars cause immediate failure at load. No Option for required fields.
- **`src/auto-pr/core.ts`** — Pure helpers. filterSemanticSubjects, formatGhOutput, etc. No Effect, no I/O.
- **`src/auto-pr/interfaces/`** — Tagless Final service interfaces (FillPrTemplate).
- **`src/auto-pr/live/`** — Live interpreters. Implements FillPrTemplate for production. Per Effect idiom, layers are attached to services: `FillPrTemplate.Live`. Workflow-specific config layers (GetCommitsConfig, GeneratePrContentConfig, etc.) provide per-workflow env validation.

**Bridge:** Core returns `Result`; shell calls `Effect.fromResult` at the boundary.

## Where to Start

- **Entry points:** `src/workflow/auto-pr-get-commits.ts`, `src/workflow/generate-pr-content.ts`, `src/workflow/create-or-update-pr.ts`, `src/tools/fill-pr-template.ts`
- **Core logic:** `src/auto-pr/core.ts`, `src/lib/fill-pr-template-core.ts`
- **Ollama integration:** `src/auto-pr/live/fill-pr-template.ts` (FillPrTemplate implementation)
- **Config:** `src/auto-pr/config.ts` — env schema and validation

## Dependency Direction

`core.ts` and `fill-pr-template-core.ts` do not depend on shell or live interpreters. Shell and live depend on core and interfaces. `live/` does not depend on `tools/`; Effect wrappers like `renderBody` live in `auto-pr/live/`.
