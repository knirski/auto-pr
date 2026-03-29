# Auto-PR AI design (index)

**Date:** 2026-03-29  
**Status:** Proposed  

## Prerequisites

1. **[Unify on OpenAI-compat `LanguageModel` (remove Ollama)](2026-03-29-ollama-to-llamacpp-migration-design.md)** — two provider ids (`llamacpp`, `github-models`), one `OpenAiClient` path, workflow/env breaks. Do this before toolkit or routing work.
2. All AI usage via **`effect/unstable/ai`** only — no parallel vendor SDKs in `src/auto-pr`.

**ADR 0007:** Do not edit [0007](../../adr/0007-ai-abstraction-layer.md) until code matches this set; then add or supersede an ADR.

## Spec split (low coupling)

| Spec | Owns |
|------|------|
| **[Effect toolkit](2026-03-29-auto-pr-effect-toolkit-design.md)** | `Tool`/`Toolkit`, prompts, `generateObject` vs tool loops, exploration phases 1–3, read-only tools |
| **[Inference & routing](2026-03-29-auto-pr-inference-and-routing.md)** | `AUTO_PR_AI_*`, pre-generate model id, metrics → band → allowlisted model, prompt placeholders |
| **[Migration](2026-03-29-ollama-to-llamacpp-migration-design.md)** | Delete Ollama, workflow inputs, checklist |

**Shared boundary:** Toolkit supplies `LanguageModel` usage patterns; routing supplies **which** model/URL (env). **Phase 3** (optional: fold get-commits into tools) touches workflows — both specs mention it; migration owns env renames.

## Agent task routing

| You are implementing… | Read |
|------------------------|------|
| `repo-toolkit.ts`, tool handlers, generation with `toolkit` | Toolkit spec |
| Model selection step, metrics, `pr-description.txt` placeholders | Inference spec |
| Removing Ollama, `config.ts` union, reusable workflow | Migration spec |
| Full vertical (tools + provider defaults) | Migration → toolkit + inference |

**Drift risk:** If `config.ts` env names change, update inference **§1.5** and user docs.
