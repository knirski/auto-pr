# Ollama removal and OpenAI-compat-only `LanguageModel`

## Context and Problem Statement

auto-pr previously shipped an Ollama-specific path: the `ollama` npm package, `ollama-language-model.ts`, workflow steps (`setup-ollama`, `ollama pull`), and env such as `AUTO_PR_AI_OLLAMA_MODEL`. That duplicated HTTP concerns and diverged from the Effect `LanguageModel` stack used elsewhere.

**Problem:** How do we drop Ollama-specific code while keeping local inference (e.g. llama.cpp OpenAI-compatible server) and GitHub Models under one HTTP implementation?

## Considered Options

* **Keep Ollama as a first-class provider** — Familiar for local dev; adds dependency surface, bespoke model wiring, and CI steps that do not apply to shared runners.
* **Unify on `@effect/ai-openai-compat` only** — `OpenAiClient` + `OpenAiLanguageModel` + `FetchHttpClient`; two **product** providers (`local`, `github-models`) distinguished by config, not separate client types.
* **Add a third enum value for every gateway** — Rejected; remote gateways use **`local`** + URL + model + key.

## Decision Outcome

Chosen option: **unify on `@effect/ai-openai-compat` only**. Remove the `ollama` dependency, delete `ollama-language-model.ts`, and remove Ollama-specific workflow inputs/steps. **Provider ids** are **`local`** and **`github-models`** only; both use shared env names **`AUTO_PR_AI_OPENAI_COMPAT_*`** for model and OpenAI-compat endpoint (no separate `LLAMACPP_*` vars in app config).

| Provider        | Role |
| --------------- | ---- |
| `github-models` | GitHub Models inference URL; `GH_TOKEN`; model via `AUTO_PR_AI_OPENAI_COMPAT_MODEL` (default e.g. `openai/gpt-4.1` when unset). |
| `local`         | `AUTO_PR_AI_OPENAI_COMPAT_URL` (default `http://127.0.0.1:8080/v1`); optional `AUTO_PR_AI_OPENAI_COMPAT_API_KEY`; same model var. |

Remote gateways (OpenRouter, Azure, etc.) use **`local`** with the appropriate URL, model id, and key.

**Principle:** All generation goes through `effect/unstable/ai` (`LanguageModel`). `@effect/ai-openai-compat` is the only HTTP `LanguageModel` implementation in application code.

### Consequences

* **Good:** One client stack; fewer env names; CI defaults to **`github-models`** on stock reusable workflows; local dev uses **`local`** + defaults in `config.ts`.
* **Good:** Tests mock `POST …/chat/completions` JSON; no Ollama daemon assumptions in unit tests.
* **Bad (breaking for adopters):** Workflows lose Ollama-specific steps; reusable workflow inputs use `ai_provider`, `ai_openai_compat_*`; `AUTO_PR_AI_OLLAMA_MODEL` removed. Documented in CHANGELOG, [INTEGRATION.md](../INTEGRATION.md), [README.md](../../README.md).

**CI:** GitHub-hosted runners: default **`github-models`** with the stock reusable workflow; **`local`** requires a reachable OpenAI-compatible endpoint (self-hosted runner, tunnel, or remote URL).

**Related decisions:** PR title/body use `LanguageModel.generateText` + JSON parse + `TitleDescriptionSchema` (not `generateObject` / `json_schema` — GitHub Models and many compat servers do not support it). Historical toolkit notes: [auto-pr-effect-toolkit design](../superpowers/specs/2026-03-29-auto-pr-effect-toolkit-design.md#generateobject-vs-generatetext). Ongoing abstraction — [0007-ai-abstraction-layer.md](0007-ai-abstraction-layer.md).

## References

* Supersedes design spec: [2026-03-29-ollama-to-llamacpp-migration-design.md](../superpowers/specs/2026-03-29-ollama-to-llamacpp-migration-design.md) (stub; this ADR is canonical)
* [0007: AI provider abstraction](0007-ai-abstraction-layer.md)
* Implementation: `src/auto-pr/live/ai-provider.ts`, `src/auto-pr/config.ts`
