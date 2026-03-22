# Config-Driven AI Provider Abstraction

## Context and Problem Statement

For 2+ commits, auto-pr needs to generate a PR title and description via an AI model. Initially this was hardcoded to Ollama with `OLLAMA_MODEL` and `OLLAMA_URL`. To support future providers (GitHub Models, OpenAI-compatible APIs) without changing user workflows, we need a pluggable abstraction.

**Problem:** How do we abstract the AI provider so auto-pr can use Ollama, GitHub Models, or any OpenAI-compatible API with minimal configuration churn?

## Considered Options

* **Single provider (Ollama only)** — Keep current design; add other providers only when needed. Simple but locks in Ollama.
* **Config-driven provider abstraction** — Introduce `AUTO_PR_AI_PROVIDER` and provider-specific env vars; dispatch via `ai-provider.ts` using Effect's `LanguageModel` interface.
* **Per-workflow provider selection** — Let each workflow/job specify its provider via inputs; no global default beyond ollama.

## Decision Outcome

Chosen option: **Config-driven provider abstraction**, because it meets the goal of a single abstraction (Effect's `LanguageModel`) with provider selection via env vars. Matches industry patterns (LiteLLM, OpenRouter) and keeps the codebase extensible.

### Consequences

* **Good:** Single interface (`LanguageModel`); swap providers via `AUTO_PR_AI_PROVIDER`; no code changes for new providers; config validated at load.
* **Good:** Workflow inputs (`ai_provider`, `ai_ollama_model`) map cleanly to env; Ollama setup only when needed.
* **Bad:** Requires migrating from `OLLAMA_MODEL`/`OLLAMA_URL` to `AUTO_PR_AI_PROVIDER`/`AUTO_PR_AI_OLLAMA_MODEL`; docs and users must update.
* **Bad:** `github-models` and `openai-compat` are deferred (not yet implemented); they fail with `AutoPrConfigError` until live adapters are added.

## References

* Design spec: [docs/superpowers/specs/2026-03-22-ai-abstraction-layer-design.md](../superpowers/specs/2026-03-22-ai-abstraction-layer-design.md)
* See also: [0001-functional-core-imperative-shell.md](0001-functional-core-imperative-shell.md) (Effect/Tagless Final context)
* Implementation: `src/auto-pr/live/ai-provider.ts`, `src/auto-pr/config.ts`
