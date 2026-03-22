# AI Abstraction Layer Design

**Date:** 2025-03-22  
**Status:** Partially implemented (Ollama path done; multi-provider deferred)  
**Summary:** Add a pluggable AI abstraction using Effect's `LanguageModel` so auto-pr can use Ollama, GitHub Models, or any OpenAI-compatible API for PR title/description generation.

**Contents:** [1. Context and Goals](#1-context-and-goals) · [2. Components and Data Flow](#2-components-and-data-flow) · [3. Error Handling](#3-error-handling) · [4. Testing](#4-testing-request-capture-verification) · [5. Workflow and Migration](#5-workflow-and-migration) · [6. Implementation Notes](#6-implementation-notes)

## 1. Context and Goals

### Current State (as implemented)

- For 2+ commits, `auto-pr-generate-content` uses `LanguageModel.generateObject` with `TitleDescriptionSchema`; `ollama-language-model.ts` adapts the official `ollama` package to Effect's `LanguageModel`.
- `runGeneratePrContent` builds `ollamaLanguageModelLayer` from config and provides it to `generatePrContentFromValues`.
- Config: `GeneratePrContentConfig` with `model`, `ollamaUrl`; `RunAutoPrConfig` mirrors that.
- **Deferred:** `ai-provider.ts`, `AUTO_PR_AI_PROVIDER`, GitHub Models, openai-compat, ResilientHttpClient, workflow input renames.

### Goals

- Support **Ollama**, **GitHub Models**, and **generic OpenAI-compatible** APIs.
- Single abstraction: Effect's `LanguageModel` from `effect/unstable/ai`.
- Unified config with `AUTO_PR_AI_PROVIDER` and provider-specific env vars.
- No real API calls in tests; request-capture mocks only.

### Out of scope

Streaming UI, multi-model fallback chains, prompt versioning, cost tracking. Single provider per run; no automatic fallback.

### Decisions (from brainstorming)

- **Config:** Unified with `AUTO_PR_AI_PROVIDER` (explicit selection).
- **Env naming:** Provider in the name (e.g. `AUTO_PR_AI_OLLAMA_MODEL`, `AUTO_PR_AI_GITHUB_MODEL`).
- **GitHub auth:** One token — `GH_TOKEN` used for both PR creation and GitHub Models API. All workflows pass the same token; generate job (when `ai_provider == "github-models"`) and create job both use `GH_TOKEN` via `secrets: inherit` or explicit `GH_TOKEN` secret.
- **Generic provider:** Add `openai-compat` for any OpenAI-compatible API.
- **Dependencies:** Published npm packages (`@effect/ai-openai-compat`, `effect` ≥ 4.0.0-beta.36).

### Best Practices Alignment

- **Provider abstraction** — Unified `LanguageModel` interface; swap providers via config (no code changes). Matches industry pattern (LiteLLM, OpenRouter, Vercel AI SDK).
- **OpenAI-compatible as default** — `github-models` and `openai-compat` use the de facto standard; covers most providers.
- **Config-driven** — Fail-fast validation; load only vars for selected provider (no unnecessary secret exposure).
- **Secrets** — Tokens stored as `Redacted`; **never** call `Redacted.value()` for logging (per AGENTS.md).
- **Structured output** — Use `LanguageModel.generateObject` with `TitleDescriptionSchema` (`{ title: string, description: string }`). Schema-validated, no string parsing; Ollama supports `format`/schema, OpenAI-compat supports `response_format`.
- **effect/unstable/ai** — Uses Effect's AI stack; when it stabilizes, update imports; API shape should remain compatible. See [Effect AI docs](https://github.com/Effect-TS/effect-smol/blob/effect%404.0.0-beta.36/LLMS.md) (replace version with `effect` from package.json) for `LanguageModel` API.

### Architecture Alignment

The implementation must follow the project's type-safe FP and FC/IS patterns (see [AGENTS.md](../../../AGENTS.md)):

- **Functional Core / Imperative Shell**
  - **Core (pure):** `validateTitleDescription` (check `isValidConventionalTitle`), `buildDescriptionPrompt` stay in `core.ts` / `fill-pr-template-core` — no Effect, no I/O, return `Result`.
  - **Shell (Effect):** `LanguageModel` adapters in `live/`; `generateTitleAndDescription` calls `LanguageModel.generateObject({ prompt, schema: TitleDescriptionSchema })` → receives `{ title, description }` → validates via `Effect.fromResult(validateTitleDescription(...))`.
- **Tagless Final**
  - `LanguageModel` is the service interface; implementations are live interpreters in `live/`. Tests provide mocks via `Layer.mock` or `LanguageModel.make()`.
- **Type safety**
  - No `any`; use `unknown` and Schema for decoding. Domain errors as `Schema.TaggedErrorClass`. No non-null assertions.
  - **All inputs and outputs use Effect Schema** — config, workflow params, AI request/response bodies, and any JSON crossing boundaries are encoded/decoded via Schema (no ad-hoc `JSON.parse` or hand-written types).

### Provider Layer Factory

- **Location:** `src/auto-pr/live/ai-provider.ts`
- Builds `Layer<LanguageModel>` from `AUTO_PR_AI_PROVIDER` and provider-specific env.
- Config validated at load; invalid provider or missing vars → `AutoPrConfigError`.
- **Retry:** Provide `ResilientHttpClient` (base `HttpClient` with `retryTransient` applied) to all providers in production. Tests use plain `HttpClient` mocks (no retry) for simplicity and speed.

### Provider Values

| Value         | Description                                              |
|---------------|----------------------------------------------------------|
| `ollama`      | Local/server Ollama                                     |
| `github-models` | GitHub Models API — convenience preset (same OpenAI-compat stack, fixed URL) |
| `openai-compat` | Custom OpenAI-compatible API (Azure, OpenRouter, etc.) |

**Note:** GitHub Models is OpenAI-compatible. `github-models` is a thin preset: same `OpenAiClient` + `OpenAiLanguageModel` as `openai-compat`, with `apiUrl: "https://models.github.ai/inference"` hardcoded and `GH_TOKEN` for auth. **Single token across all workflows** — generate and create jobs both receive `GH_TOKEN`; no separate token for AI.

### Config Schema

| Provider       | Required env vars                                                                 | Defaults                                                                 |
|----------------|-----------------------------------------------------------------------------------|---------------------------------------------------------------------------|
| `ollama`       | — (we start Ollama ourselves; URL is fixed)                                     | `AUTO_PR_AI_OLLAMA_MODEL` default `llama3.1:8b`. URL: `http://localhost:11434/api/generate` (hardcoded). |
| `github-models`| `GH_TOKEN`, `AUTO_PR_AI_GITHUB_MODEL`                                            | —                                                                        |
| `openai-compat`| `AUTO_PR_AI_OPENAI_COMPAT_URL`, `AUTO_PR_AI_OPENAI_COMPAT_API_KEY`, `AUTO_PR_AI_OPENAI_COMPAT_MODEL` | —                                                                        |

Shared: `AUTO_PR_AI_PROVIDER` — optional. When absent or empty, fall back to `ollama` and log a warning. When present, must be one of `ollama`, `github-models`, `openai-compat`.

### Environment variables (quick reference)

| Env var | Provider | Notes |
|---------|----------|-------|
| `AUTO_PR_AI_PROVIDER` | all | Optional; default `ollama` |
| `AUTO_PR_AI_OLLAMA_MODEL` | ollama | Optional; default `llama3.1:8b` |
| `GH_TOKEN` | github-models | Required when provider is github-models |
| `AUTO_PR_AI_GITHUB_MODEL` | github-models | Required |
| `AUTO_PR_AI_OPENAI_COMPAT_URL` | openai-compat | Required |
| `AUTO_PR_AI_OPENAI_COMPAT_API_KEY` | openai-compat | Required |
| `AUTO_PR_AI_OPENAI_COMPAT_MODEL` | openai-compat | Required |

### Config Interface

`GeneratePrContentConfig` (and `RunAutoPrConfig`) gain:

- `readonly provider: "ollama" | "github-models" | "openai-compat"`
- `readonly model: string`
- Provider-specific fields: Ollama — `model` only (no url); `openai-compat` — `url`, `apiKey` (redacted), `model`; `github-models` — `token` (redacted), `model`.

Config layer reads `AUTO_PR_AI_PROVIDER`; if missing/empty, defaults to `ollama` and logs a warning. Loads only the vars for the selected provider. Config validated at load (eagerly); no deferral. Ollama is default anyway.

**Fallback behavior:** When `AUTO_PR_AI_PROVIDER` is not set or blank, treat as `ollama` and log a warning (e.g. `AUTO_PR_AI_PROVIDER not set, defaulting to ollama`).

**Ollama URL:** We start Ollama ourselves (workflow uses setup-ollama); the URL is known. No `AUTO_PR_AI_OLLAMA_URL` — use constant `http://localhost:11434/api/generate`.

**Ollama model:** `AUTO_PR_AI_OLLAMA_MODEL` defaults to `llama3.1:8b` when omitted.

**run-auto-pr (local):** Same fixed localhost URL for Ollama when running the local pipeline; no separate config path.

## 2. Components and Data Flow

### Components

| Component            | Location                                      | Role                                                                 |
|----------------------|-----------------------------------------------|----------------------------------------------------------------------|
| `ResilientHttpClient`| `src/auto-pr/live/` or ai-provider            | `FetchHttpClient.layer` + `HttpClient.retryTransient`; production only. Tests use plain mocks. |
| `AiProviderLayer`    | `src/auto-pr/live/ai-provider.ts`              | Builds `Layer<LanguageModel>` from config; dispatches by provider; provides ResilientHttpClient to adapters. |
| `OllamaLanguageModel`| `src/auto-pr/live/ollama-language-model.ts`   | `LanguageModel.make()` adapter: Prompt ↔ Ollama `{ model, prompt }`. |
| OpenAiCompat wiring  | Uses `@effect/ai-openai-compat`               | `OpenAiClient` + `OpenAiLanguageModel.model()`. Shared for both `github-models` and `openai-compat`; `github-models` = preset with fixed URL + `GH_TOKEN` / `AUTO_PR_AI_GITHUB_MODEL`. |
| `generateTitleAndDescription` | `src/workflow/auto-pr-generate-content.ts` | Uses `LanguageModel.generateObject({ prompt, schema: TitleDescriptionSchema })`; fallback when title invalid (no custom retries). |

### Data Flow

1. `GeneratePrContentConfigLayer` reads `AUTO_PR_AI_PROVIDER` and provider env.
2. `AiProviderLayer` creates the appropriate `LanguageModel` layer and merges into `GeneratePrContentLayer`.
3. `generatePrContentFromValues` (params: provider-agnostic `provider`, `model`, and provider-specific config) → `generateTitleAndDescription` → `LanguageModel.generateObject({ prompt, schema: TitleDescriptionSchema })`.
4. Response `{ title, description }` → `validateTitleDescription` (conventional title check) → `renderBodyCore` (unchanged).

### Core Stays Pure (FC/IS boundary)

- `validateTitleDescription({ title, description })` — pure validation (e.g. `isValidConventionalTitle`); returns `Result<..., DescriptionParseError>`. **Generalize prompt and response validation** — not Ollama-specific; prompt (e.g. `buildDescriptionPrompt` / `pr-description.txt`) and `validateTitleDescription` work for all providers. Consider improving the prompt for effectiveness across Ollama, GitHub Models, and openai-compat.
- `generateTitleAndDescription` yields `LanguageModel.generateObject(...)` → receives `{ title, description }` → `Effect.fromResult(validateTitleDescription(...))` at the boundary.
- Remove `parseTitleDescriptionResponse`, `validateDescriptionResponse`, `trimOllamaResponse`; structured output replaces string parsing.

## 3. Error Handling

| Source              | Mapping                                                       |
|---------------------|---------------------------------------------------------------|
| HTTP / transport    | Map to `AiProviderError` (provider-agnostic; replaces `OllamaHttpError`). |
| LanguageModel / AI  | Map `AiError` to `AiProviderError`.                           |
| Invalid response    | Schema decode failures or `validateTitleDescription` failures → `DescriptionParseError`. |
| Config              | `AutoPrConfigError` for missing/invalid env.                  |

- **AiProviderError** — transport/API failures from any provider. `Schema.TaggedErrorClass` with `status?: number`, `cause: string`. Replaces `OllamaHttpError`.
- **DescriptionParseError** — schema decode or `validateTitleDescription` failures. `Schema.TaggedErrorClass` with `cause: string`. Replaces `OllamaDescriptionInvalidError`.
- **errors.ts:** Add both; remove `OllamaHttpError`, `OllamaDescriptionInvalidError`; update `formatError`.
- **index.ts:** Export `AiProviderError`, `DescriptionParseError`; remove `OllamaHttpError`; remove `parseTitleDescriptionResponse`, `validateDescriptionResponse`, `trimOllamaResponse` from core exports.

## 4. Testing: Request-Capture Verification

**Verified achievable.** Both Ollama and OpenAiCompat use `HttpClient`; `HttpClient.make` receives `(request, url)` with full request access. No integration tests needed.

**Approach:**
- `CapturingHttpClientMock(capturedRef: Ref<CapturedRequest[]>, responses)` — `Layer<HttpClient>`. Handler pushes `{ url, method, body }` to `capturedRef` before returning stub response. Request/response bodies decoded via Effect Schema (not raw `JSON.parse`) for type-safe assertion.
- Stub responses: Ollama → `{ response: JSON.stringify({ title, description }) }`; OpenAI-compat → `{ choices: [{ message: { content: JSON.stringify({...}) } }] }`.
- Tests: run pipeline with capturing mock, read `capturedRef`, assert `url` contains expected path (`/api/generate` or full localhost URL for Ollama, `chat/completions` for openai-compat), body has `model`, `prompt`/`messages`, `format` for Ollama.

**Config tests:** Unit tests per provider — missing env → `AutoPrConfigError`; valid config → layer builds.

**Adapt existing tests:** errors.test.ts — replace OllamaHttpError/OllamaDescriptionInvalidError assertions with AiProviderError/DescriptionParseError; generate-pr-content.test.ts — update to assert on new error types.

## 5. Workflow and Migration

### Workflow Changes

- **Inputs:** Replace `ollama_model`, `ollama_url` with provider-agnostic inputs that map to env:
  - `ai_provider` (default: `ollama`)
  - `ai_ollama_model` (default: `llama3.1:8b`) — no URL input; we use fixed localhost URL
  - `ai_github_model` (uses existing `GH_TOKEN` secret)
  - `ai_openai_compat_url`, `ai_openai_compat_api_key`, `ai_openai_compat_model`

- **Steps:**
  - "Setup Ollama" and "Pull model" run only when 2+ commits **and** `ai_provider == "ollama"` (i.e. only when we know Ollama will be used). Condition: `steps.commits.outputs.count != '1' && inputs.ai_provider == 'ollama'`
  - "Generate PR content" receives the new env vars.

### Documentation (complete checklist)

| File | Updates |
|------|---------|
| `README.md` | Replace Ollama references with AI provider; update Environment variables table (`AUTO_PR_AI_PROVIDER` optional; `AUTO_PR_AI_OLLAMA_MODEL` default `llama3.1:8b`; no URL for ollama); "Ollama for 2+ commits" → "AI provider for 2+ commits" |
| `docs/INTEGRATION.md` | Overview: "Ollama generates" → "AI generates"; Environment variables reference (note `AUTO_PR_AI_PROVIDER` fallback); Troubleshooting table (Ollama returns invalid → provider-agnostic) |
| `docs/TROUBLESHOOTING.md` | Section "Ollama / 2+ commits" → "AI provider / 2+ commits"; replace `OLLAMA_MODEL` with `AUTO_PR_AI_OLLAMA_MODEL` (default); no URL; document `AUTO_PR_AI_PROVIDER` fallback; add GitHub Models and openai-compat failure modes |
| `docs/ARCHITECTURE.md` | Pipeline flow: "Ollama summarize" → "AI summarize"; Where to Start: "Ollama integration" → "AI integration" (`src/auto-pr/live/ai-provider.ts`, `ollama-language-model.ts`) |
| `docs/adr/ai-abstraction-layer.md` | Create ADR documenting this design (per AGENTS.md ADR workflow for significant architectural changes) |
| `AGENTS.md` | Update "Where to Put X" if it references Ollama integration; point to `ai-provider.ts` and `ollama-language-model.ts` for AI integration |
| `src/auto-pr/prompts/pr-description.txt` | Generalize and improve prompt for effectiveness across all providers (Ollama, GitHub Models, openai-compat) |
| `docs/PR_TEMPLATE.md` | "Ollama" → "AI" in Usage, `{{description}}` source, `--description-file`, `--output-description-prompt`, `--format title-body`, Behavior, Implementation notes |
| `docs/WORKFLOW_SECURITY.md` | "Ollama" → "AI" in Generate job description |
| `.github/workflows/auto-pr-generate-reusable.yml` | Replace `ollama_model`, `ollama_url` with `ai_provider`, `ai_ollama_model` (default `llama3.1:8b`); drop `ollama_url` (use fixed localhost); "Setup Ollama" and "Pull model" only when 2+ commits and `ai_provider == "ollama"`; pass new env to Generate PR content; `GH_TOKEN` via `secrets: inherit` when `github-models` (same token as create job) |
| `.github/workflows/auto-pr.yml` | No `with:` passed today; reusable uses defaults. When adding `github-models` support: pass `secrets: inherit` to generate job so it receives `GH_TOKEN`. If adding explicit overrides later, use new input names (`ai_provider`, `ai_ollama_model`, etc.) |
| `package.json` | Consider adding `github-models` or `openai` to keywords (optional) |

## 6. Implementation Notes

### Schemas for All I/O

All inputs and outputs (JSON or config) must use Effect Schema:
- **Config:** `GeneratePrContentConfig`, `RunAutoPrConfig` decoded from env via Schema.
- **Workflow inputs:** Map GitHub Actions `with:` to env; validate with Schema where needed.
- **AI request bodies:** Ollama/OpenAI payloads encoded via Schema (e.g. `OllamaGenerateRequestSchema`).
- **AI response bodies:** `TitleDescriptionSchema` for structured output; provider-specific response schemas for raw responses when parsing.
- **generatePrContentFromValues params:** Input type backed by Schema for validation.

### Structured Output Schema

```ts
const TitleDescriptionSchema = Schema.Struct({
  title: Schema.String,
  description: Schema.String,
});
```

- Use `LanguageModel.generateObject({ prompt, schema: TitleDescriptionSchema })`. Effect constructs the prompt to request JSON; providers return text; Effect decodes.

### Ollama Adapter

- POST to `http://localhost:11434/api/generate` (fixed; we use the generate endpoint only). Model from config (default `llama3.1:8b`).
- For `generateObject`: Effect's prompt includes JSON schema; we implement `generateText` that POSTs to Ollama.
- Use Ollama `format` parameter for the generate endpoint: `format: "json"` with schema in prompt (generate endpoint does not support structured `format` objects; chat endpoint does, but we use generate only).
- Map Ollama response to `[TextDeltaPart(jsonText), FinishPart(...)]`.

### GitHub Models

- Base URL: `https://models.github.ai/inference` (client appends `/chat/completions`).
- Model IDs: `{publisher}/{model_name}` (e.g. `openai/gpt-4.1`).
- Auth: Bearer `GH_TOKEN` (same token as PR creation).

### Retry Strategy

- **ResilientHttpClient** — base `HttpClient` wrapped with `HttpClient.retryTransient`. Used in production for all providers (Ollama, github-models, openai-compat). Replaces custom Ollama retry.
- **Tests** — use plain `HttpClient` mocks (e.g. `CapturingHttpClientMock`); no retry layer. Simpler and faster.
- **Invalid title** (successful 200 but non-conventional format): no retry; fall back to first-commit subject + `getDescriptionFromCommits` immediately.

### Dependencies

- Add `@effect/ai-openai-compat` (peer or direct).
- `effect` already at 4.0.0-beta.36; ensure compatibility with `effect/unstable/ai` and `effect/unstable/http`.

### OpenAiClient and ResilientHttpClient

- Verify that `OpenAiClient` from `@effect/ai-openai-compat` uses `HttpClient` from the Effect context so that providing `ResilientHttpClient` via `Layer.provide` wires retries for its requests.

### Implementation Order

Suggested phases: (1) Add `AiProviderError`, `DescriptionParseError`; update `formatError`, `index.ts`. (2) Add `validateTitleDescription`; remove `parseTitleDescriptionResponse`, `validateDescriptionResponse`, `trimOllamaResponse`. (3) Build Ollama adapter (`ollama-language-model.ts`). (4) Add `ai-provider.ts` and `AiProviderLayer`. (5) Update config layers, `generatePrContentFromValues`, `runGeneratePrContent`. (6) Update workflows and docs.

### Verify during implementation

- `LanguageModel.generateObject` API shape in `effect/unstable/ai` (or Effect AI docs)
- `OpenAiClient` uses `HttpClient` from context so `ResilientHttpClient` wiring works
- GitHub Models API availability and auth flow

### Implementation complete when

- [ ] All 6 phases done
- [ ] ADR created or updated in `docs/adr/`
- [ ] `bun run check` passes
- [ ] `bun run check:ci` passes
