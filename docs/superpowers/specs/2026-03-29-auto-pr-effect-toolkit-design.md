# Auto-PR AI: Effect repository toolkit and generation

**Date:** 2026-03-29  
**Status:** Proposed  
**Companion:** [Inference & routing](2026-03-29-auto-pr-inference-and-routing.md) — providers, env, metrics, pre-generate model id.

**Summary:** Replace static “dump everything in one prompt” with on-demand exploration via Effect `Tool` + `Toolkit` (`effect/unstable/ai`) and `LanguageModel`.

## Principle

- Use `effect/unstable/ai` only: `LanguageModel`, `Tool`/`Toolkit`, `AiError`, `Prompt`/`Response` as needed. `@effect/ai-openai-compat` provides `LanguageModel`, not a parallel API in feature code.
- Product providers: `local` and `github-models` only — same `OpenAiClient` + `OpenAiLanguageModel`; see [migration](2026-03-29-ollama-to-llamacpp-migration-design.md).

## 1. Problem / goals

Today: `auto-pr-get-commits` writes `commits.txt` / `files.txt`; `auto-pr-generate-content` sends one large prompt.

Limits: token waste on big PRs; model cannot open files or diffs on demand; temp files between steps.

Goals: on-demand context; exploratory repo reads; emphasize important changes (full pre-inference ranking is unreliable — see [Importance before inference](2026-03-29-auto-pr-inference-and-routing.md#importance-before-inference)); long-term optional merge of gather + generate via tools.

## 2. Toolkit (Effect v4)

### APIs

`Tool.make`, `Toolkit.make`, `Toolkit.toLayer`; pass `toolkit` into `LanguageModel.generateText` / `generateObject` per pinned `effect` + `@effect/ai-openai-compat` (4.x). Pin versions with repo `package.json`.

### Example

```typescript
import { Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";

const GetCommitHistory = Tool.make("GetCommitHistory", {
  description: "Recent commit subjects and SHAs (lightweight).",
  success: Schema.String,
});
const GetCommitDiff = Tool.make("GetCommitDiff", {
  description: "Full diff for a commit SHA.",
  parameters: Schema.Struct({ sha: Schema.String }),
  success: Schema.String,
});
const GetFileContent = Tool.make("GetFileContent", {
  description: "File text at path relative to repo root.",
  parameters: Schema.Struct({ path: Schema.String }),
  success: Schema.String,
});

const RepoToolkit = Toolkit.make(GetCommitHistory, GetCommitDiff, GetFileContent);
const RepoToolkitLayer = RepoToolkit.toLayer({
  GetCommitHistory: () => runGitLogSubjects(),
  GetCommitDiff: ({ sha }) => runGitDiffForCommit(sha),
  GetFileContent: ({ path }) => readFileUnderWorkspace(path),
});
```

Handlers return `Effect`. Reuse existing git execution (`runCommand` / `ChildProcess` — no replacement required).

### `LanguageModel` wiring

Same imports as production `ai-provider.ts` (subpaths from `@effect/ai-openai-compat`):

```typescript
import { Effect, Layer, Redacted } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import * as OpenAiClient from "@effect/ai-openai-compat/OpenAiClient";
import * as OpenAiLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel";

const clientLayer = OpenAiClient.layer({
  apiUrl: "https://api.example.com/v1",
  apiKey: Redacted.make("your-api-key"),
}).pipe(Layer.provide(FetchHttpClient.layer));
const modelLayer = OpenAiLanguageModel.model("your-model-id").pipe(Layer.provide(clientLayer));

const program = LanguageModel.generateText({ prompt: "…", toolkit: RepoToolkit }).pipe(
  Effect.provide(RepoToolkitLayer),
  Effect.provide(modelLayer),
);
```

Local llama-server: `apiUrl` = `…/v1` base (e.g. `http://127.0.0.1:8080/v1`); omit `apiKey` if unused. URL/model in CI vs local: [inference spec](2026-03-29-auto-pr-inference-and-routing.md).

### `generateObject` vs `generateText`

**Shipped generate-content:** `LanguageModel.generateText` + parse JSON + `TitleDescriptionSchema` — not `generateObject` — because GitHub Models does not allow `response_format: json_schema` and other OpenAI-compat servers are inconsistent with structured-output mode. See [ARCHITECTURE.md](../../ARCHITECTURE.md).

| Use | When |
|-----|------|
| `generateText` + manual parse + `TitleDescriptionSchema` | **Current** PR metadata path for `local` and `github-models`. |
| `generateObject` + schema | Effect API option; not used for the multi-commit PR title/description path (provider gaps above). |
| `generateText` + `toolkit` | Exploration (Phase 2): multi-turn tool use. |
| Two-phase | `generateText` + tools → then structured JSON on condensed context if one-call tool+object is flaky. |

`generateObject` + `toolkit` on one call: `GenerateObjectOptions` extends `GenerateTextOptions`, but tool rounds + structured JSON together is provider-dependent — verify per backend if adopted.

Tool loop (Effect): provider sends tool definitions → model may return tool calls → handlers run in Effect → results appended → repeat until final text/object. `disableToolCallResolution` exists for manual control.

### Shapes for auto-pr

| Shape | When |
|-------|------|
| `generateText({ prompt })` → parse JSON → `TitleDescriptionSchema` | **Shipped** multi-commit PR metadata. |
| `generateObject({ prompt, schema })` only | Alternative in Effect; not used for shipped generate-content. |
| `generateText({ prompt, toolkit })` → structured second call | Explore first; second call is structured. |
| `generateObject({ prompt, schema, toolkit })` | Fewer round-trips if backend supports it (not used in shipped path). |

Layers: `Effect.provide` `RepoToolkitLayer` and `modelLayer`.

## 3. Roadmap

| Phase | Work |
|-------|------|
| 1 | `src/auto-pr/live/repo-toolkit.ts`; wrap existing git reads in tool handlers. |
| 2 | Wire `RepoToolkit` into generation; validate tools + structured output on both backends; prompt updates. |
| 3 (optional) | Fold `auto-pr-get-commits` into tool layer where workflows adopt exploration — coordinate with [inference §2](2026-03-29-auto-pr-inference-and-routing.md) (env-driven model). |

## 4. Constraints

- Read-only tools (no repo writes during analysis).
- Cache repeated tool results in one Effect run.
- No vendor SDKs in `src/auto-pr` beyond OpenAI-compat + `effect/unstable/ai`.
