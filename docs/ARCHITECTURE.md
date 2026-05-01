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
│  workflow: generate-pr-content, create-or-update-pr, run-auto-pr│
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

1. **generate-content** — `GitContext` fetches commits, files, and diff stat directly from git. 1 commit: fill from body; 2+: `LanguageModel.generateText` with `DiffToolkit` (`get_diff`, `get_commit_diff` tools), parse assistant JSON, validate with Effect Schema (`TitleDescriptionSchema`), using **local** (OpenAI-compatible HTTP) or **github-models** (selected by config). Not `generateObject` (OpenAI `json_schema` is unsupported on GitHub Models and flaky on some compat servers). Retries → commit-derived fallback on failure → fill template (including `{{typeOfChange}}` aligned with the final PR title) → write `pr-title.txt` and `pr-body.md` under workspace
2. **create-or-update-pr** — Read `pr-title.txt` / `pr-body.md` → `PullRequestClient` lookup by branch → PR update or create through Octokit REST API

## Functional Core / Imperative Shell (FC/IS)

- **`src/workflow/*.ts`** — Main auto-PR workflow. generate-content, create-or-update-pr, run-auto-pr.
- **`src/tools/*.ts`** — Standalone tools. fill-pr-template, init.
- **`src/core/*.ts`** — Pure core modules. fill-pr-template-core, collapse-prose-paragraphs, init-core, string, gh-output, errors.
- **`src/auto-pr/shell.ts`** — Imperative shell. runCommand, appendGhOutput, runMain. Uses `@effect/platform-bun` for FileSystem, Path, ChildProcessSpawner, Runtime. Orchestrates I/O.
- **`src/auto-pr/paths.ts`** — Path resolution for package-relative assets. `getPrDescriptionPromptPath` resolves `dist/prompts/pr-description.txt` (relative to shared chunk in `dist/`).
- **`src/auto-pr/config.ts`** — Workflow-specific config layers. Validate and fail early: required env vars cause immediate failure at load. No Option for required fields.
- **`src/auto-pr/interfaces/`** — Tagless Final service interfaces (FillPrTemplate).
- **`src/auto-pr/live/`** — Live interpreters. Implements FillPrTemplate for production. Per Effect idiom, layers are attached to services: `FillPrTemplate.Live`. Workflow-specific config layers (GeneratePrContentConfig, etc.) provide per-workflow env validation.
- **`GitContext`** — Typed Effect service for git reads (commits, files, diff stat). Used by generate-content instead of pre-written text files. All methods apply a hard 30-second timeout; a hung process surfaces as a named error rather than blocking indefinitely.
- **`DiffToolkit`** — Tool use for AI: exposes `get_diff` and `get_commit_diff` tools so the language model can fetch diff data on demand during generation. All responses pass through `sanitizeDiffForAi` (strips binary hunks, caps per-file and total size) before being returned to the model.

**Bridge:** Core returns `Result`; shell calls `Effect.fromResult` at the boundary.

## Where to Start

- **Entry points:** `src/workflow/auto-pr-generate-content.ts`, `src/workflow/auto-pr-create-or-update-pr.ts`, `src/workflow/auto-pr-run.ts`, `src/tools/auto-pr-fill-pr-template.ts`, `src/tools/auto-pr-init.ts`
- **Local CI parity (optional):** `scripts/act-local-ci.ts` (`bun run act`) — Docker + nektos act or `gh act`; pure argv/event planning lives in the same file (scoped FC/IS exception). See [CONTRIBUTING.md](../CONTRIBUTING.md#run-ci-locally-check-job).
- **Core logic:** `src/core/*.ts` (fill-pr-template-core, gh-output, string, etc.)
- **AI integration:** `src/auto-pr/live/ai-provider.ts` dispatches to **local** and **github-models** (both via `@effect/ai-openai-compat`); `src/workflow/auto-pr-generate-content.ts` calls `LanguageModel.generateText` and decodes JSON to `TitleDescriptionSchema` (see file header). CI uses composite actions from `knirski/auto-pr` for the generate job (no vendored `scripts/` in consumer repos).
- **Config:** `src/auto-pr/config.ts` — env schema and validation

## Dependency Direction

`src/core/` does not depend on shell or live interpreters. Shell and live depend on core and interfaces. `live/` does not depend on `tools/`; Effect wrappers like `renderBody` live in `auto-pr/live/`.

## Error Handling

Domain errors (e.g. `NoSemanticCommitsError`, `AutoPrConfigError`) use `Schema.TaggedErrorClass` in `src/core/errors.ts`. The shell formats them via `formatError` (in `src/auto-pr/errors.ts`) and logs to stderr before exiting non-zero. In GitHub Actions, failures surface as step failures; `AUTO_PR_DEBUG=1` adds a hint to the log. **generate-content** writes workspace files on success.

AI errors are split into **permanent** and **transient** via `isTransientAiError` (`src/auto-pr/errors.ts`). Permanent failures (HTTP 401/403, `AuthenticationError`) surface immediately as `AutoPrConfigError` — they indicate bad credentials that retrying cannot fix. Transient failures (network, rate limit, 5xx, parse errors) continue to the existing retry-then-fallback path. See [ADR 0013](adr/0013-transient-vs-permanent-ai-errors.md).

## Glossary

| Term | Meaning |
|------|---------|
| **FC/IS** | Functional Core / Imperative Shell. The core (`src/core/*.ts`) contains pure functions returning `Result`; no Effect, no I/O. The shell (`src/auto-pr/shell.ts`) orchestrates I/O and bridges via `Effect.fromResult`. |
| **Tagless Final** | Effect idiom: define service interfaces (e.g. `FillPrTemplate`); implement as live interpreters in `live/`; tests swap mocks. |
| **Conventional commits** | Commit message format: `type(scope): subject` (e.g. `feat: add X`, `fix(scope): resolve Y`). See [conventionalcommits.org](https://www.conventionalcommits.org/). |
| **GITHUB_OUTPUT** | GitHub Actions mechanism for passing data between steps. Key-value pairs appended to a file; later steps read via `${{ steps.id.outputs.key }}`. Title/body for the PR use workspace files (`pr-title.txt`, `pr-body.md`), not `GITHUB_OUTPUT`. |
| **GitHub App** | OAuth app for GitHub; creates tokens with repository permissions. auto-pr uses it for PR creation (not `GITHUB_TOKEN`) so PRs are attributed to the app. |
| **Two-phase workflow** | Split into generate (unprivileged checkout) and create (trusted checkout, PR write). Satisfies CodeQL/CWE-829; see [WORKFLOW_SECURITY.md](WORKFLOW_SECURITY.md). |
| **ai/\* branch** | Branch name pattern that triggers the auto-pr workflow. Push to `ai/feature-x` → workflow creates/updates PR. |
| **Effect** | TypeScript library for typed functional programming. Used for error handling, dependency injection, and async. |
| **Result** | Type from `effect` or similar: `Ok(value)` or `Err(error)`. Core returns `Result`; shell bridges to `Effect`. |
| **Domain errors** | Tagged error classes live in `src/core/errors.ts`; `formatError` (shell) in `src/auto-pr/errors.ts`. Core defines, shell formats for logging. |
| **ActBackend (`direct` / `gh`)** | How `act-local-ci` invokes act: **`direct`** runs `bash scripts/nix-run-if-missing.sh act …` when `act` or `nix` is on `PATH`; **`gh`** runs `gh act …` when the gh-act extension is available. See `ActBackend` and `planActRun` in [`scripts/act-local-ci.ts`](../scripts/act-local-ci.ts). |

## Related

- [ADR 0001: Functional Core / Imperative Shell](adr/0001-functional-core-imperative-shell.md)
- [ADR 0002: Two-phase auto-PR workflow](adr/0002-two-phase-auto-pr-workflow.md)
- [ADR 0007: AI provider abstraction](adr/0007-ai-abstraction-layer.md)
- [ADR 0009: Ollama removal and OpenAI-compat-only LanguageModel](adr/0009-ollama-to-openai-compat-migration.md)
