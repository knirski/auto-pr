# Auto-PR AI design (index)

**Date:** 2026-03-29  
**Status:** Proposed  

## Prerequisites

1. [Unify on OpenAI-compat `LanguageModel` (remove Ollama)](2026-03-29-ollama-to-llamacpp-migration-design.md) — two provider ids (`local`, `github-models`), one `OpenAiClient` path, workflow/env breaks. Do this before toolkit or routing work.
2. All AI usage via `effect/unstable/ai` only — no parallel vendor SDKs in `src/auto-pr`.

ADR 0007: do not edit [0007](../../adr/0007-ai-abstraction-layer.md) until code matches this set; then add or supersede an ADR.

## Spec split (low coupling)

| Spec | Owns |
|------|------|
| [Effect toolkit](2026-03-29-auto-pr-effect-toolkit-design.md) | `Tool`/`Toolkit`, prompts, `generateObject` vs tool loops, exploration phases 1–3, read-only tools |
| [Inference & routing](2026-03-29-auto-pr-inference-and-routing.md) | `AUTO_PR_AI_*`, pre-generate model id, metrics → band → allowlisted model, prompt placeholders |
| [Migration](2026-03-29-ollama-to-llamacpp-migration-design.md) | Delete Ollama, workflow inputs, checklist |

Shared boundary: toolkit supplies `LanguageModel` usage patterns; routing supplies which model/URL (env). Phase 3 (optional: fold get-commits into tools) touches workflows — both specs mention it; migration owns env renames.

## Where to start

| Task | Spec |
|------|------|
| `repo-toolkit.ts`, tool handlers, generation with `toolkit` | Toolkit |
| Model selection step, metrics, `pr-description.txt` placeholders | Inference |
| Removing Ollama, `config.ts` union, reusable workflow | Migration |
| Full vertical (tools + provider defaults) | Migration → toolkit + inference |

If `config.ts` env names change, update the inference doc (environment contract table) and user docs.
