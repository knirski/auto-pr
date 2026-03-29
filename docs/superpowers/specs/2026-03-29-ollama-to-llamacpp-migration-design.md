# Unify AI on OpenAI-compatible `LanguageModel` (remove Ollama)

**Date:** 2026-03-29  
**Status:** Proposed — **prerequisite** to toolkit + routing work  

**Summary:** Remove **`ollama`** package, **`ollama-language-model.ts`**, and Ollama workflow steps. **Two** provider ids — **`llamacpp`**, **`github-models`** — one implementation: **`@effect/ai-openai-compat`** (`OpenAiClient.layer` + `OpenAiLanguageModel.model`) + **`FetchHttpClient`**. No separate **`openai-compat`** enum: any OpenAI-compatible URL uses **`llamacpp`** with env overrides.

## Principle

All generation through **`effect/unstable/ai`** (`LanguageModel`, later `Tool`/`Toolkit`). **`@effect/ai-openai-compat`** is the only HTTP `LanguageModel` implementation in app code.

## Current state (remove)

- Default / `AUTO_PR_AI_PROVIDER=ollama`; `ollama-language-model.ts`; `ollama` npm dep.
- Optional **`openai-compat`** branch (redundant once all backends are OpenAI-shaped).
- Workflows: `ai-action/setup-ollama`, `ollama pull`, `ai_ollama_model`, default `ai_provider: ollama`.
- Env: `AUTO_PR_AI_OLLAMA_MODEL`, `AUTO_PR_AI_OPENAI_COMPAT_*`.

## Target

| Provider | Config |
|----------|--------|
| **`github-models`** | `apiUrl`: `https://models.github.ai/inference`; `apiKey`: `GH_TOKEN`; model: `AUTO_PR_AI_GITHUB_MODEL` |
| **`llamacpp`** | `apiUrl`: `AUTO_PR_AI_LLAMACPP_URL` (default e.g. `http://127.0.0.1:8080/v1`); optional `AUTO_PR_AI_LLAMACPP_API_KEY`; model: `AUTO_PR_AI_LLAMACPP_MODEL` |

Remote gateways (OpenRouter, Azure, etc.): **`llamacpp`** + URL + model + key.

**Removed env:** `AUTO_PR_AI_OLLAMA_MODEL`, `ollama` string, standalone `AUTO_PR_AI_OPENAI_COMPAT_*`.

## Breaking (adopters)

- Reusable workflow: drop Ollama steps; new inputs/env for two providers.
- Document in CHANGELOG, [INTEGRATION.md](../../INTEGRATION.md), [README.md](../../README.md).

## CI

GitHub-hosted runners: do not assume local llama.cpp — prefer **`github-models`** when `GH_TOKEN` exists, or document self-hosted for **`llamacpp`**.

## Implementation checklist

| Area | Action |
|------|--------|
| `package.json` | Drop `ollama` |
| `ollama-language-model.ts` | Delete |
| `ai-provider.ts` | Only `llamacpp` + `github-models`; shared `OpenAiClient` |
| `config.ts` | Union + env schema; remove Ollama / openai-compat keys |
| `index.ts` | Remove ollama layer export |
| `auto-pr-generate-content.ts`, `auto-pr-run.ts` | Unified config → `aiProviderLayerFromConfig` |
| `.github/workflows/auto-pr-generate-reusable.yml` | Align inputs/env |
| Tests | Mock `POST …/chat/completions` JSON |
| Docs | README, INTEGRATION, TROUBLESHOOTING — two providers only |

## Testing

- Unit: `aiProviderLayerFromConfig` for both providers with mock **`fetch`** / `HttpClient`.
- Integration: `generatePrContentFromValues` with 2+ commits, HTTP mocked.

## Resolved / open

| Topic | Decision |
|-------|----------|
| `generateObject` for title/body | Yes — [toolkit](2026-03-29-auto-pr-effect-toolkit-design.md#generateobject-vs-generatetext) |
| ADR 0007 | Revise or add ADR after code lands — leave [0007](../../adr/0007-ai-abstraction-layer.md) until then |
| Default llama-server port | Document in config; `8080` may vary by build |
| Workflow default when unset | Document CI (`github-models`?) vs local (`llamacpp`) separately |
