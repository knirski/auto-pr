# Auto-PR AI: Inference providers and model routing

**Date:** 2026-03-29  
**Status:** Proposed  
**Companion:** [Effect toolkit](2026-03-29-auto-pr-effect-toolkit-design.md) — tools, `generateObject` vs loops.

**Summary:** Backend choice (`llamacpp` vs `github-models`), `AUTO_PR_AI_*`, pre-generate model id (no router in `generate-content`), metrics → band → allowlisted model, and prompt placeholders. Stack: `LanguageModel` via `@effect/ai-openai-compat`. Ollama removal: [migration](2026-03-29-ollama-to-llamacpp-migration-design.md).

## Independence from tools

Metrics, model selection, and routing context can ship with `generateObject` + offline git + commit text without `Tool`/`Toolkit`. Tools are optional for targeted diffs/files ([toolkit spec](2026-03-29-auto-pr-effect-toolkit-design.md)). Band → model id stays allowlisted in code, never LLM-chosen.

---

## 1. Providers and models

### Conventions

`AUTO_PR_AI_PROVIDER` ∈ { `llamacpp`, `github-models` }. Both use `OpenAiClient.layer` + `OpenAiLanguageModel.model` + `FetchHttpClient`. No separate `openai-compat` enum; remote OpenAI-compatible hosts use `llamacpp` with URL + model + optional key.

ADR 0007: revise after implementation; do not edit preemptively ([index](2026-03-29-dynamic-ai-tooling-design.md)).

### Size (rule of thumb)

~8B instruct default for multi-commit narrative; ~3B for lean CPU / short copy; avoid 32B+ for PR copy alone. Prefer smaller quants + bounded prompts + tools over raw scale.

### `github-models`

- Docs: [GitHub Models](https://docs.github.com/en/github-models) (billing, rate limits, catalog).
- Env: `AUTO_PR_AI_PROVIDER=github-models`, `GH_TOKEN`, `AUTO_PR_AI_GITHUB_MODEL`.
- Defaults: prefer mini/small chat rows for quota on free Actions; confirm ids in live catalog.

### `llamacpp`

- OpenAI-compatible `…/v1` (e.g. [llama.cpp](https://github.com/ggerganov/llama.cpp) llama-server `http://127.0.0.1:8080/v1` — port from your flags).
- Env: `AUTO_PR_AI_LLAMACPP_URL` (optional default), `AUTO_PR_AI_LLAMACPP_MODEL`, optional `AUTO_PR_AI_LLAMACPP_API_KEY`.
- Any OpenAI-compatible gateway: same preset, override URL/key.
- Tool calling / JSON: depends on server + model — re-test after upgrades.
- GitHub-hosted runners: poor fit for local inference; use `github-models` or self-hosted for `llamacpp`.

### Structured PR output

Prefer `LanguageModel.generateObject` + `{ title, description }` — [generateObject vs generateText](2026-03-29-auto-pr-effect-toolkit-design.md#generateobject-vs-generatetext).

### Environment contract (post–Ollama — align `config.ts`)

| Variable | When |
|----------|------|
| `AUTO_PR_AI_PROVIDER` | `llamacpp` \| `github-models` |
| `AUTO_PR_AI_GITHUB_MODEL` | Required if `github-models` |
| `GH_TOKEN` | GitHub Models + existing PR flows |
| `AUTO_PR_AI_LLAMACPP_URL` | Optional; default e.g. llama-server `/v1` |
| `AUTO_PR_AI_LLAMACPP_MODEL` | Required if `llamacpp` |
| `AUTO_PR_AI_LLAMACPP_API_KEY` | Optional Bearer for gated endpoints |

Removed: `ollama`, `AUTO_PR_AI_OLLAMA_MODEL`, standalone `AUTO_PR_AI_OPENAI_COMPAT_*`.

### Importance before inference

Goal: description emphasizes user-visible / breaking / security work, not lockfile-only or `dist/` noise.

Perfect “importance” ranking without human review or deep analysis is not available. Pre-inference steps can only denoise, bucket, and order input (denylists, `delta_src` vs `delta_raw`, `gen_ratio`, heuristics on paths/subjects). The model (optionally with tools) does synthesis and emphasis. Pattern: curate budget → summarize; see §3 for metrics.

---

## 2. Dynamic model selection

Resolve one model id before `generate-content` (workflow step or orchestration writes env). `generate-content` does not embed a router.

Pattern: get-commits → select model (compute §3 signals, allowlist id to `GITHUB_OUTPUT`) → generate job passes `AUTO_PR_AI_*`. Security: only fixed model strings (`case` / regex), never free-form branch output.

Separate step rationale: quota/cost policy (e.g. GitHub Models free tier: small PR → mini; hard PR → stronger id).

---

## 3. Metrics for routing

### 3.0 When metrics apply

| `count` (semantic commits) | Behavior |
|----------------------------|----------|
| 1 | Existing behavior: template from single commit — no AI narrative path. No model selection for tiering. |
| ≥ 2 | §3.1–3.6 inform which model id before generate. |

### 3.1 Goals

Cover typical PRs and edge cases: huge diffs (source vs `dist/`), generated-heavy PRs, synthesis-hard multi-area work. Two dimensions: (1) volume — meaningful change to summarize; (2) hardness — difficulty unifying commits. Avoid using `delta_raw` alone when lockfiles dominate.

### 3.2 Raw signals (git-derived)

From `origin/<default_branch>...HEAD` (not raw `commits.txt` length). Names are ASCII (`snake_case`) for code, logs, and prompts.

| Signal | Meaning |
|--------|---------|
| `n_sem` | Semantic commit count |
| `delta_raw` | `git diff --numstat` insert+delete, all paths |
| `delta_src` | Same excluding §3.4 denylist |
| `path_count` | Distinct paths touched |
| `s_spread` | Distinct top-level dirs / package roots |
| `delta_gen` | Numstat sum on denylisted paths only |
| `gen_ratio` | `delta_gen / max(delta_raw, 1)` — generated-noise share of line churn |

Minimum routing pair: `n_sem` + `delta_src` (fallback `delta_raw` if path split not ready).

### 3.3 Hardness (heuristic)

Raise hardness: diverse conventional types, high `s_spread`, contract/migration paths, mixed `docs/` + `src/`. Lower: same area, one story.

### 3.4 Denylist (examples — extend per repo)

`dist/`, `build/`, `out/`, `.next/`, `coverage/`, `*.lock`, `pnpm-lock.yaml`, `package-lock.json`, `Cargo.lock`, `go.sum`, `*.min.js`, `*.map`, `__snapshots__/`, `.terraform/`, `vendor/`.

Pitfall: high `gen_ratio`, small `delta_src` — do not escalate model on noise; prefer truncation + [toolkit](2026-03-29-auto-pr-effect-toolkit-design.md).

### 3.5 Bands (policy sketch)

Fixed allowlists in workflow: band → model id. Calibrate thresholds per repo.

| Band | Idea |
|------|------|
| A — Light | Low `n_sem`, low `delta_src`, low hardness → smallest tier |
| B — Standard | Default mid volume + moderate hardness |
| C — Heavy | High `delta_src` or high hardness (not `gen_ratio` alone) → stronger chat model; try truncation + tools before largest frontier |

### 3.6 Edge cases

| Case | Mitigation |
|------|------------|
| One huge commit, small `n_sem` | Weight `delta_src`, subjects |
| Many tiny commits | Weight `delta_src` + `s_spread`; don’t over-weight count |
| Regenerated `dist/` | `gen_ratio` + small `delta_src` → down-rank |

### 3.7 Model ids

Validate against the live [GitHub Models catalog](https://github.com/marketplace/models) or API. Names/tiers change.

- Hosted CI: e.g. `openai/gpt-4o-mini` for bands A–B; step up for C when `delta_src` or hardness warrants — confirm quota/tier.
- Local `llamacpp`: instruction-tuned GGUFs; match server’s registered model string for `/v1/chat/completions`. Re-test `generateObject` after model/server changes.

Deprioritize: branch name alone; raw `commits.txt` byte length.

### 3.8 Routing vs prompt

| Channel | Role |
|---------|------|
| Routing | Sets env → `LanguageModel` layer. Model never chooses endpoint/id. |
| Prompt | Small bounded “routing context” (band, buckets) conditions tone/emphasis — trusted fields only (§3.9). |

### 3.9 Prompt injection of metrics

Pass only code-computed, trusted values — not raw branch names or unchecked workflow text.

Suggested fields (bucketed): band `A|B|C`; `n_sem`; `delta_src` bucket (`small|medium|large`); `gen_ratio` as `low|medium|high`; hardness `low|medium|high`. One short instruction line: prefer user-visible/breaking; don’t center on lockfiles unless they’re the story.

### 3.10 `pr-description.txt` vNext

Shipped today: `src/auto-pr/prompts/pr-description.txt` — evolve in place when implementing routing.

Add placeholders (filled by `buildDescriptionPrompt` or equivalent):

| Placeholder | Content |
|-------------|---------|
| `{{ROUTING_CONTEXT}}` | §3.9 block or empty |
| `{{COMMIT_CONTENT}}` | Same commit slice as today (not unlimited diff) |

Order in template: rules → optional routing block → commits.

```typescript
function buildDescriptionPrompt(
  template: string,
  commitContent: string,
  routingContext?: string,
): string {
  const r = (routingContext ?? "").trim();
  return template
    .replace("{{ROUTING_CONTEXT}}", r)
    .replace("{{COMMIT_CONTENT}}", commitContent);
}
```

Schema: still `generateObject` → `{ title, description }`; routing text is prompt only, not JSON.

Do not feed unbounded diff just because metrics are large — still truncate/path-filter (§1 “importance”, §3.4).

---

## 4. Implementation touchpoints

- Workflows: `.github/workflows/auto-pr-generate-reusable.yml` — env after [migration](2026-03-29-ollama-to-llamacpp-migration-design.md).
- Config: `src/auto-pr/config.ts` — two-provider union; single dispatch.
- Scripts: step between get-commits and generate sets model env; optional emission of bounded routing fields for §3.10.
- Prompts: `pr-description.txt` + `buildDescriptionPrompt` — placeholders above.
