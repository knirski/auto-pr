# AI Abstraction Layer Design (historical)

**Date:** 2026-03-22  
**Status:** Superseded — **do not implement from this file.**

## Current direction

Use the **2026-03-29** set (two providers **`llamacpp`** + **`github-models`**, one OpenAI-compat stack, no Ollama):

| Doc | Role |
|-----|------|
| [2026-03-29-dynamic-ai-tooling-design.md](2026-03-29-dynamic-ai-tooling-design.md) | **Index** — task routing, prerequisites |
| [2026-03-29-ollama-to-llamacpp-migration-design.md](2026-03-29-ollama-to-llamacpp-migration-design.md) | **First** — remove Ollama, unify `ai-provider` |
| [2026-03-29-auto-pr-inference-and-routing.md](2026-03-29-auto-pr-inference-and-routing.md) | Env, metrics, routing, prompts |
| [2026-03-29-auto-pr-effect-toolkit-design.md](2026-03-29-auto-pr-effect-toolkit-design.md) | `Tool`/`Toolkit`, exploration phases |

**ADR:** [0007](../../adr/0007-ai-abstraction-layer.md) stays as the committed record until implementation; then add or revise an ADR to match the 2026-03-29 stack.

## What this file described (archive summary)

Effect **`LanguageModel`**, multi-provider config, **`generateObject`** for title/body, FC/IS split (`core` pure, `live/` adapters). The **Ollama + `openai-compat` enum** details here are **obsolete**; the **pattern** (schema-validated output, `Layer` mocks in tests) still matches [ARCHITECTURE.md](../../ARCHITECTURE.md) and ADR 0007’s intent.
