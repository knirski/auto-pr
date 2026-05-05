# AI provider abstraction

## Context and Problem Statement

For 2+ commits, auto-pr needs to generate a PR title and description via an AI model. Early versions used Ollama-specific wiring (`OLLAMA_MODEL`, `OLLAMA_URL`). We need a small, stable abstraction so callers can use **local OpenAI-compatible HTTP** (e.g. llama.cpp) or **GitHub Models** without bespoke code paths per backend.

**Problem:** How do we keep one `LanguageModel` implementation in app code while supporting multiple deployment modes (self-hosted inference vs GitHub-hosted API)?

## Considered Options

* **Single hardcoded backend** — Simple but blocks CI on shared runners and couples the project to one vendor.
* **Config-driven provider abstraction** — Introduce `AUTO_PR_AI_PROVIDER` and provider-specific env vars; dispatch via `ai-provider.ts` using Effect's `LanguageModel` interface.
* **Per-workflow provider selection** — Map workflow `inputs` → env; defaults differ for CI vs local (documented in INTEGRATION.md).

## Decision Outcome

Chosen option: **config-driven provider abstraction** with **two** product providers: **`local`** and **`github-models`**. Both use `OpenAiClient` / `OpenAiLanguageModel` from `@effect/ai-openai-compat` (`src/auto-pr/live/ai-provider.ts`). Configuration and validation live in `src/auto-pr/config.ts`.

### Consequences

* **Good:** Single interface (`LanguageModel`); swap providers via `AUTO_PR_AI_PROVIDER`; config validated at load.
* **Good:** Workflow inputs (`ai_provider`, model and OpenAI-compat fields) map cleanly to env.
* **Neutral:** Adopters who relied on Ollama-specific workflow steps or `AUTO_PR_AI_OLLAMA_MODEL` must migrate to `local` / `AUTO_PR_AI_OPENAI_COMPAT_*` or `github-models`.

**Implementation:** `github-models` uses the fixed GitHub Models inference URL and `GH_TOKEN` plus routing output (`AUTO_PR_ROUTING_DECISION_JSON`) for selected model/tool requirement. **`local`** uses `AUTO_PR_AI_OPENAI_COMPAT_URL`, optional `AUTO_PR_AI_OPENAI_COMPAT_API_KEY`, and `AUTO_PR_LOCAL_MODEL`.

## References

* Migration (Ollama removal): [ADR 0009](0009-ollama-to-openai-compat-migration.md) — design-era stub: [2026-03-29-ollama-to-llamacpp-migration-design.md](../superpowers/specs/2026-03-29-ollama-to-llamacpp-migration-design.md)
* Design history: [docs/superpowers/specs/2026-03-22-ai-abstraction-layer-design.md](../superpowers/specs/2026-03-22-ai-abstraction-layer-design.md)
* See also: [0001-functional-core-imperative-shell.md](0001-functional-core-imperative-shell.md) (Effect / Tagless Final context)
* Implementation: `src/auto-pr/live/ai-provider.ts`, `src/auto-pr/config.ts`
