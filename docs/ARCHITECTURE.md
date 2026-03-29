# Architecture

This project uses [Effect](https://effect.website/) v4 beta and [TypeScript Native](https://devblogs.microsoft.com/typescript/announcing-typescript-native-previews/) (`tsgo`) for typecheck. Bun.build (scripts/build.ts) builds `dist/` from entrypoints derived from `package.json` bin (pkgroll convention); bins run via `node dist/workflow/auto-pr-*.js` and `node dist/tools/auto-pr-*.js`. Prompts at `dist/prompts/`. No declaration emit.

## Repository layout (on disk)

- **`src/`** — TypeScript source. `src/core/` is pure (no Effect I/O); `src/auto-pr/` holds config, errors, live interpreters, and shell; `src/workflow/` and `src/tools/` are CLI entrypoints compiled to `dist/` by `scripts/build.ts`.
- **`scripts/`** — Build and check helpers (`build.ts`, shell wrappers, Nix shims). Not application library code.
- **`test/`** — Unit tests, mirroring `src/` where applicable.

## High-Level Structure

```
┌─────────────────────────────────────────────────────────────────┐
│  CLI entry points (src/workflow/*.ts, src/tools/*.ts)           │
│  workflow: auto-pr-get-commits, generate-pr-content,            │
│  create-or-update-pr, run-auto-pr                               │
│  tools: fill-pr-template, init                                 │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  Imperative Shell (src/auto-pr/shell.ts, config.ts)             │
│  Orchestrates I/O, reads env, calls core via Effect.fromResult  │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  Functional Core (src/core/*.ts)                                │
│  Pure functions, no Effect, no I/O, returns Result              │
└─────────────────────────────────────────────────────────────────┘
```

## Pipeline Flow

1. **get-commits** — `git log` + `git diff` → `commits.txt`, `files.txt` under workspace; append `commits`, `files`, `count` to `GITHUB_OUTPUT`
2. **generate-content** — Parse commits → 1 commit: fill from body; 2+: `LanguageModel` via `generateObject`, using **local** (OpenAI-compatible HTTP) or **github-models** (selected by config) → fill template → write `pr-title.txt` and `pr-body.md` under workspace
3. **create-or-update-pr** — Read `pr-title.txt` / `pr-body.md` → `gh pr view` → `gh pr edit` or `gh pr create`

## Functional Core / Imperative Shell (FC/IS)

- **`src/workflow/*.ts`** — Main auto-PR workflow. get-commits, generate-content, create-or-update-pr, run-auto-pr.
- **`src/tools/*.ts`** — Standalone tools. fill-pr-template, init.
- **`src/core/*.ts`** — Pure core modules. fill-pr-template-core, collapse-prose-paragraphs, init-core, string, gh-output, errors.
- **`src/auto-pr/shell.ts`** — Imperative shell. runCommand, appendGhOutput, runMain. Uses `@effect/platform-bun` for FileSystem, Path, ChildProcessSpawner, Runtime. Orchestrates I/O.
- **`src/auto-pr/paths.ts`** — Path resolution for package-relative assets. `getPrDescriptionPromptPath` resolves `dist/prompts/pr-description.txt` (relative to shared chunk in `dist/`).
- **`src/auto-pr/config.ts`** — Workflow-specific config layers. Validate and fail early: required env vars cause immediate failure at load. No Option for required fields.
- **`src/auto-pr/core.ts`** — Re-exports from `src/core/` for backward compatibility.
- **`src/auto-pr/interfaces/`** — Tagless Final service interfaces (FillPrTemplate).
- **`src/auto-pr/live/`** — Live interpreters. Implements FillPrTemplate for production. Per Effect idiom, layers are attached to services: `FillPrTemplate.Live`. Workflow-specific config layers (GetCommitsConfig, GeneratePrContentConfig, etc.) provide per-workflow env validation.

**Bridge:** Core returns `Result`; shell calls `Effect.fromResult` at the boundary.

## Where to Start

- **Entry points:** `src/workflow/auto-pr-get-commits.ts`, `src/workflow/auto-pr-generate-content.ts`, `src/workflow/auto-pr-create-or-update-pr.ts`, `src/workflow/auto-pr-run.ts`, `src/tools/auto-pr-fill-pr-template.ts`, `src/tools/auto-pr-init.ts`
- **Core logic:** `src/core/*.ts` (fill-pr-template-core, gh-output, string, etc.)
- **AI integration:** `src/auto-pr/live/ai-provider.ts` dispatches to **local** and **github-models** (both via `@effect/ai-openai-compat`); `src/workflow/auto-pr-generate-content.ts` calls `LanguageModel.generateObject` for PR title/description. CI uses composite actions from `knirski/auto-pr` for the generate job (no vendored `scripts/` in consumer repos).
- **Config:** `src/auto-pr/config.ts` — env schema and validation

## Dependency Direction

`src/core/` does not depend on shell or live interpreters. Shell and live depend on core and interfaces. `live/` does not depend on `tools/`; Effect wrappers like `renderBody` live in `auto-pr/live/`.

## Error Handling

Domain errors (e.g. `NoSemanticCommitsError`, `AutoPrConfigError`) use `Schema.TaggedErrorClass` in `src/core/errors.ts`. The shell formats them via `formatError` (in `src/auto-pr/errors.ts`) and logs to stderr before exiting non-zero. In GitHub Actions, failures surface as step failures; `AUTO_PR_DEBUG=1` adds a hint to the log. **get-commits** only appends to `GITHUB_OUTPUT` after it succeeds; **generate-content** writes workspace files on success.

## Related

- [ADR 0001: Functional Core / Imperative Shell](adr/0001-functional-core-imperative-shell.md)
- [ADR 0002: Two-phase auto-PR workflow](adr/0002-two-phase-auto-pr-workflow.md)
- [ADR 0007: AI provider abstraction](adr/0007-ai-abstraction-layer.md)
- [ADR 0009: Ollama removal and OpenAI-compat-only LanguageModel](adr/0009-ollama-to-openai-compat-migration.md)
- [CONCEPTS.md](CONCEPTS.md) — Glossary of terms
