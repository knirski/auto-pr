# OpenRouter Migration Design

**Date:** 2026-08-04  
**Status:** Approved  
**Companion specs:** [AI abstraction layer](2026-03-22-ai-abstraction-layer-design.md), [Inference and routing](2026-03-29-auto-pr-inference-and-routing.md), [Dynamic GitHub Models Usage](2026-05-04-dynamic-github-model-usage-design.md), [GitHub Models Selection Policy Improvement](2026-05-06-github-models-selection-policy-design.md)

## Summary

Replace the retired `github-models` cloud provider with `openrouter`.

GitHub Models is no longer a viable backend: as of 2026-07-30, GitHub retired the playground, model catalog, inference API, and BYOK for all customers. auto-pr should therefore remove GitHub Models from the active provider set rather than keep it as a supported option.

OpenRouter becomes the default cloud provider for multi-commit PR content generation. The local OpenAI-compatible provider remains unchanged for llama.cpp and self-hosted inference. OpenRouter generation uses OpenRouter's OpenAI-compatible chat completions endpoint, an OpenRouter API key, and free-tier model IDs with the `vendor/model:free` shape.

## External API Evidence

### GitHub Models Retirement

GitHub's 2026-07-30 changelog states that GitHub Models is retired and that its playground, model catalog, inference API, and BYOK are no longer available to customers.

Source: <https://github.blog/changelog/2026-07-30-github-models-is-now-retired/>

### OpenRouter Chat Completions

OpenRouter documents an OpenAI-compatible chat completions endpoint:

- Base URL: `https://openrouter.ai/api/v1`
- Chat endpoint: `POST /chat/completions`
- Authentication: `Authorization: Bearer <OPENROUTER_API_KEY>`
- Optional attribution headers: `HTTP-Referer` and `X-OpenRouter-Title`

Source: <https://openrouter.ai/docs>

### OpenRouter Model Metadata

OpenRouter documents `GET /api/v1/models` for model metadata. The response includes model IDs, pricing, context length, architecture metadata, and supported parameters. Free model variants use the `:free` suffix.

Source: <https://openrouter.ai/docs/guides/overview/models>

### OpenRouter Free Limits

OpenRouter documents free-model rate limits as:

- 20 requests per minute
- 50 requests per day without credits
- 1000 requests per day with at least the documented credit threshold

OpenRouter also documents `GET /api/v1/key` for current API key metadata, limits, remaining balance, usage, and `is_free_tier`.

Sources:

- <https://openrouter.ai/docs/api-reference/limits>
- <https://openrouter.ai/docs/faq>

### GitHub Actions Secret Wiring

GitHub documents two constraints that affect the CI migration:

- Secrets are not automatically passed to reusable workflows.
- Secrets cannot be directly referenced in `if:` conditionals; copy them to environment variables
  when conditional step skipping is required.

Source: <https://docs.github.com/actions/security-guides/using-secrets-in-github-actions>

## Current State

Implemented today:

- `AUTO_PR_AI_PROVIDER` is `local | github-models`.
- The stock `auto-pr.yml` and reusable generate workflow default to `github-models`.
- GitHub Actions generate jobs request `models: read`.
- `GH_TOKEN` is used for both GitHub API reads and GitHub Models inference.
- `src/auto-pr/live/ai-provider.ts` maps `github-models` to `https://models.github.ai/inference`.
- `src/workflow/auto-pr-build-model-routing-context.ts` fetches the GitHub Models catalog, detects GitHub/Copilot plan signals, and builds GitHub-specific request envelopes.
- `src/core/github-model-routing.ts` models GitHub rate-limit tiers, free-tier limits, model fallback, and request-envelope clamping.
- `src/workflow/auto-pr-generate-content.ts` builds GitHub Models fallback attempts from GitHub catalog entries, then optionally falls back to local.
- Docs and tests refer to GitHub Models throughout.

This code is now structurally sound but operationally broken because the GitHub Models catalog and inference API are retired.

## Goals

- Replace `github-models` with `openrouter` as the default cloud provider.
- Keep `local` behavior and llama.cpp workflow support unchanged.
- Use free OpenRouter models by default, preferring explicit `vendor/model:free` IDs.
- Keep FC/IS boundaries: pure routing and model selection in `src/core`, live HTTP repositories in `src/auto-pr/live`, orchestration in `src/workflow`.
- Preserve the existing generate/create trust boundary from ADR 0016.
- Remove unnecessary GitHub Actions `models: read` permissions.
- Provide clear migration errors for users still setting `AUTO_PR_AI_PROVIDER=github-models`.
- Update tests, docs, and workflow examples so adopters use `OPENROUTER_API_KEY`.

## Non-Goals

- Supporting paid OpenRouter model routing in this migration. Paid models can be enabled later by adding an explicit opt-in policy.
- Implementing Microsoft Foundry or GitHub Copilot as alternate cloud backends.
- Changing the PR prompt, JSON parsing path, or `LanguageModel.generateText` strategy.
- Changing the local llama.cpp provider, image pinning, Docker actions, or local model sizing policy.
- Building a global quota scheduler across many branches. The stock workflow should reduce burst risk, but OpenRouter free daily quota remains account-level.
- Keeping GitHub Models as an active provider. It should remain only in historical ADR/spec references.

## Design Decision

Recommended and approved approach: replace `github-models` with `openrouter`.

Rejected alternatives:

| Approach | Result |
|----------|--------|
| Keep `github-models` as deprecated-but-supported | Misleading. The upstream service is retired, so the option cannot work. |
| Add `openrouter` as a third provider | Increases public surface and test burden while preserving a dead provider. |
| Treat OpenRouter as `local` only | Fastest patch, but loses a safe default, free-model validation, OpenRouter-specific errors, docs clarity, and workflow input clarity. |

## Provider Contract

### Active Providers

`AiProvider` becomes:

```ts
export type AiProvider = "local" | "openrouter";
```

`ModelProvider` in routing artifacts becomes the same active union:

```ts
export type ModelProvider = "local" | "openrouter";
```

### Retired Provider Handling

`AUTO_PR_AI_PROVIDER=github-models` should fail early with `AutoPrConfigError`.

Error text should be explicit:

```text
Invalid AUTO_PR_AI_PROVIDER: github-models. GitHub Models was retired on 2026-07-30; use openrouter or local.
```

This is better than silently aliasing `github-models` to `openrouter`, because the auth, model IDs, permissions, and billing semantics are different.

## Configuration

### Environment Variables

Add:

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | yes when provider is `openrouter` | OpenRouter API key used as bearer token. |
| `AUTO_PR_OPENROUTER_MODEL` | no | Preferred OpenRouter model ID. Must be a free model by default, normally `vendor/model:free`. |
| `AUTO_PR_OPENROUTER_HTTP_REFERER` | no | Optional OpenRouter attribution URL. |
| `AUTO_PR_OPENROUTER_TITLE` | no | Optional OpenRouter attribution title. Defaults to `auto-pr`. |

Keep:

| Variable | Provider | Description |
|----------|----------|-------------|
| `AUTO_PR_AI_PROVIDER` | both | `openrouter` by default in stock workflows; `local` for self-hosted OpenAI-compatible endpoints. |
| `AUTO_PR_AI_OPENAI_COMPAT_URL` | local | Local/external OpenAI-compatible base URL. |
| `AUTO_PR_AI_OPENAI_COMPAT_API_KEY` | local | Optional local/external endpoint API key. |
| `AUTO_PR_LOCAL_MODEL` | local | Local model ID. |
| `AUTO_PR_ROUTING_DECISION_JSON` | openrouter | Required for cloud multi-commit generation, produced by routing step. |
| `AUTO_PR_ROUTING_CONTEXT_JSON` | both | Optional prompt routing context, produced by routing step. |
| `GH_TOKEN` | GitHub operations only | Optional for generate-time PR title lookup and required for create/update operations; not used for OpenRouter inference. |

Remove from active cloud inference:

| Variable | Replacement |
|----------|-------------|
| `GH_TOKEN` for model inference | `OPENROUTER_API_KEY` |
| `INTEGRATION_GITHUB_MODEL` | `INTEGRATION_OPENROUTER_MODEL` |

### Defaults

Use:

```ts
export const DEFAULT_AI_PROVIDER: AiProvider = "local";
export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-oss-20b:free";
export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_TITLE = "auto-pr";
```

`DEFAULT_AI_PROVIDER` remains `local` at the library/config layer to preserve CLI safety when no provider is configured. The stock reusable workflow input default becomes `openrouter`, replacing today's `github-models` workflow default.

The default OpenRouter model is intentionally a `vendor/model:free` ID. The model catalog can replace it with a better available free model for the route; if the catalog is unavailable, the default remains the static fallback.

## OpenRouter Model Metadata

Create OpenRouter-specific core types in `src/core/openrouter-routing.ts`:

```ts
export type OpenRouterModelCatalogEntry = {
  readonly id: string;
  readonly name: string;
  readonly contextLength: number;
  readonly supportedParameters: readonly string[];
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly promptPrice: number;
  readonly completionPrice: number;
};

export type OpenRouterModelSelection = {
  readonly model: string;
  readonly requiresToolCalls: boolean;
  readonly selectionMode:
    | "preferred"
    | "configured"
    | "free-tool-fallback"
    | "free-text-fallback"
    | "static-fallback";
  readonly catalogEntry?: OpenRouterModelCatalogEntry;
};
```

`OpenRouterModelCatalogEntry` should normalize OpenRouter's model response:

- `context_length` -> `contextLength`
- `pricing.prompt` -> `promptPrice`
- `pricing.completion` -> `completionPrice`
- `supported_parameters` -> `supportedParameters`
- `architecture.input_modalities` -> `inputModalities`
- `architecture.output_modalities` -> `outputModalities`

Parsing rules:

- Skip malformed entries without failing the whole catalog.
- Treat missing `context_length` as `8_000`.
- Treat missing prices as `0` only when the ID ends with `:free`; otherwise treat missing prices as non-free.
- Treat string prices with decimal values as numbers.
- Treat missing `supported_parameters` as no advertised parameter support.

## Free Model Policy

OpenRouter selection should use free models unless a future paid-model feature explicitly opts in.

Free model predicate:

```ts
function isOpenRouterFreeModel(entry: OpenRouterModelCatalogEntry): boolean {
  return entry.id.endsWith(":free") && entry.promptPrice === 0 && entry.completionPrice === 0;
}
```

The static default also requires the `:free` suffix:

```ts
DEFAULT_OPENROUTER_MODEL = "openai/gpt-oss-20b:free";
```

If a user sets `AUTO_PR_OPENROUTER_MODEL`, validate that it either:

- ends with `:free`, or
- equals `openrouter/free`

For this migration, reject paid-looking model IDs. The error should explain that paid OpenRouter routing is intentionally out of scope.

## Route Classes And Candidate Preferences

Keep the existing banding and tool strategy logic. Replace GitHub model IDs with OpenRouter route-class preferences.

```ts
export type OpenRouterRouteClass =
  | "A-text-light"
  | "B-text-medium"
  | "B-tool-medium"
  | "C-text-strong"
  | "C-tool-strong";
```

Mapping:

- band A with `requiresToolCalls=false` -> `A-text-light`
- band B with `requiresToolCalls=false` -> `B-text-medium`
- band B with `requiresToolCalls=true` -> `B-tool-medium`
- band C with `requiresToolCalls=false` -> `C-text-strong`
- band C with `requiresToolCalls=true` -> `C-tool-strong`

Initial policy preferences:

```ts
const OPENROUTER_FREE_MODEL_PREFERENCES: Record<
  OpenRouterRouteClass,
  readonly string[]
> = {
  "A-text-light": [
    "openai/gpt-oss-20b:free",
    "google/gemma-4-26b-a4b-it:free",
    "cohere/north-mini-code:free",
  ],
  "B-text-medium": [
    "openai/gpt-oss-20b:free",
    "google/gemma-4-26b-a4b-it:free",
    "cohere/north-mini-code:free",
  ],
  "B-tool-medium": [
    "openai/gpt-oss-20b:free",
    "google/gemma-4-26b-a4b-it:free",
    "cohere/north-mini-code:free",
  ],
  "C-text-strong": [
    "openai/gpt-oss-20b:free",
    "google/gemma-4-26b-a4b-it:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
  ],
  "C-tool-strong": [
    "openai/gpt-oss-20b:free",
    "google/gemma-4-26b-a4b-it:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
  ],
};
```

These are policy preferences, not hard dependencies. Catalog filtering decides whether a preferred model is currently available and supports the required request shape.

## Model Selection

Selection order:

1. If `AUTO_PR_OPENROUTER_MODEL` is set and valid, use it as the preferred seed.
2. Build the route class from existing `ModelBandDecision`.
3. Fetch OpenRouter catalog with a short timeout.
4. Filter to free text-output models.
5. If tools are required, filter to models whose `supported_parameters` include both `tools` and `tool_choice`.
6. Prefer configured/route preference order when entries are feasible.
7. Fall back to any feasible free tool-capable model for tool routes.
8. Fall back to any feasible free text model for text routes.
9. If the catalog is unavailable or unusable, use the static default `openai/gpt-oss-20b:free`.

Feasibility rules:

- Text output is required when `architecture.output_modalities` exists.
- Tool routes require `tools` and `tool_choice`.
- The requested token budget plus output reserve must fit the catalog `context_length`.
- Models with non-zero prompt or completion pricing are rejected.
- Models without `:free` are rejected except `openrouter/free`, which is allowed only when explicitly configured.

Do not add paid fallbacks in this migration.

## Request Envelope

Replace GitHub-specific `GithubModelsRequestEnvelope` with an OpenRouter-neutral cloud envelope:

```ts
export type CloudModelRequestEnvelope = {
  readonly provider: "openrouter";
  readonly model: string;
  readonly contextLength: number;
  readonly requestedInputTokens: number;
  readonly requestedOutputTokens: number;
  readonly tokenBudget: number;
  readonly toolRoundLimit: number;
  readonly toolResponseCharBudget: number;
  readonly source: "catalog" | "static-fallback" | "configured";
};
```

Budget logic can reuse the existing requested-envelope math from `src/core/github-model-routing.ts`, but the names should stop referencing GitHub. OpenRouter free limits are request-count limits, not per-model rate-limit tiers in the GitHub sense, so remove GitHub plan-class and rate-limit-tier fields from active routing output.

Routing decision JSON should remain backward-compatible in shape where useful:

```json
{
  "provider": "openrouter",
  "selectedModel": "openai/gpt-oss-20b:free",
  "requiresToolCalls": true,
  "tokenBudget": 12000,
  "toolRoundLimit": 6,
  "toolResponseCharBudget": 8000,
  "band": "B",
  "selectionMode": "catalog"
}
```

Remove or rename GitHub-specific workflow outputs:

- Remove `github_models_plan_class`
- Remove `github_models_rate_limit_tier`
- Remove `github_models_envelope_source`
- Add `cloud_model_envelope_source`
- Add `openrouter_model_context_length`

## Live Services

Replace:

- `src/auto-pr/interfaces/github-models-catalog-repository.ts`
- `src/auto-pr/live/github-models-catalog-repository.ts`

With:

- `src/auto-pr/interfaces/openrouter-models-repository.ts`
- `src/auto-pr/live/openrouter-models-repository.ts`

Repository interface:

```ts
export type OpenRouterModelsRepositoryService = {
  readonly fetchModels: (
    apiKey: Redacted.Redacted<string>,
  ) => Effect.Effect<readonly OpenRouterModelCatalogEntry[], never>;
};
```

Live behavior:

- `GET https://openrouter.ai/api/v1/models?limit=1000`
- Use `Authorization: Bearer <OPENROUTER_API_KEY>` when available.
- Timeout after 5 seconds.
- Return `[]` on non-2xx, network, timeout, or parse failures.
- Never log or expose the API key.

Authentication errors for actual inference remain hard failures. Catalog discovery failures degrade to static free-model fallback.

## AI Provider Layer

Extend `src/auto-pr/live/ai-provider.ts`:

```ts
export type AiProviderConfigOpenRouter = {
  readonly provider: "openrouter";
  readonly model: string;
  readonly apiKey: Redacted.Redacted<string>;
  readonly httpReferer?: string;
  readonly title?: string;
};
```

OpenRouter client options:

```ts
{
  apiUrl: "https://openrouter.ai/api/v1",
  apiKey: openRouter.apiKey,
  transformClient: addOpenRouterHeaders(...)
}
```

Use the existing `@effect/ai-openai-compat` stack. Add attribution headers via `OpenAiClient.Options.transformClient` or an equivalent `HttpClient.mapRequest` transform:

- `HTTP-Referer` only when non-empty
- `X-OpenRouter-Title` with configured value or `auto-pr`

Keep the existing fetch-level tool-call message normalization. It applies to OpenAI-compatible chat requests and should be provider-independent.

Validation:

- API key must be non-empty.
- Model must be non-empty and pass free-model validation.
- Attribution headers must not contain CR/LF.

## Generate Content Fallbacks

Replace GitHub attempt planning:

- `buildGithubModelAttemptPlan`
- `decideGithubModelFallback`
- `classifyGithubModelFailure`

With provider-neutral or OpenRouter-specific names:

- `buildOpenRouterModelAttemptPlan`
- `decideCloudModelFallback`
- `classifyCloudModelFailure`

Attempt plan for OpenRouter:

1. selected OpenRouter model with tools if tools are required
2. selected OpenRouter model without tools
3. catalog fallback model with tools if different and tools are required
4. catalog fallback model without tools
5. optional local fallback with tools
6. optional local fallback without tools
7. primitive commit-derived fallback

Authentication/config failures (`401`, `403`, malformed key, empty model) should fail the job. Rate-limit or provider availability failures (`429`, `5xx`, network timeout) should retry and then move through the fallback plan. `402 Payment Required` should be treated as config/quota exhaustion and fail with an OpenRouter-specific troubleshooting hint.

## Workflow Changes

### Stock `auto-pr.yml`

- Default cloud provider remains the stock behavior, but now through OpenRouter.
- Remove `models: read` from the generate job permissions.
- Pass `OPENROUTER_API_KEY` secret to the reusable generate workflow.
- Add `strategy.max-parallel: 2` to reduce free-tier burst risk across many `ai/**` branches.
- Update the file header and generate-job comments: the generate workflow is still unprivileged
  with no GitHub write/App credentials, but cloud generation now receives an optional OpenRouter
  inference secret. Do not leave "NO secrets" wording without that qualification.

### Reusable Generate Workflow

Change inputs/secrets:

- `ai_provider` default: `openrouter`
- Add optional secret `OPENROUTER_API_KEY`. Reusable workflows do not receive repository or
  organization secrets automatically, so callers must pass this secret explicitly.
- Keep secret `GH_TOKEN` only for GitHub PR lookup compatibility when needed.
- Remove comments describing `GH_TOKEN` as a model-inference token.
- Remove job-level `models: read`.

OpenRouter env must be wired into both OpenRouter-capable steps:

- `Build model routing context` needs `OPENROUTER_API_KEY` and `AUTO_PR_OPENROUTER_MODEL`, because
  that step fetches the OpenRouter model catalog and applies the configured free-model preference.
- `Generate PR content` needs `OPENROUTER_API_KEY`, `AUTO_PR_OPENROUTER_MODEL`,
  `AUTO_PR_OPENROUTER_HTTP_REFERER`, and `AUTO_PR_OPENROUTER_TITLE`, because that step performs
  inference and sends optional OpenRouter attribution headers.

Build model routing context env:

```yaml
AUTO_PR_AI_PROVIDER: ${{ inputs.ai_provider }}
OPENROUTER_API_KEY: ${{ inputs.ai_provider == 'openrouter' && secrets.OPENROUTER_API_KEY || '' }}
AUTO_PR_OPENROUTER_MODEL: ${{ inputs.ai_openrouter_model }}
```

Generate PR content env:

```yaml
AUTO_PR_AI_PROVIDER: ${{ inputs.ai_provider }}
OPENROUTER_API_KEY: ${{ inputs.ai_provider == 'openrouter' && secrets.OPENROUTER_API_KEY || '' }}
AUTO_PR_OPENROUTER_MODEL: ${{ inputs.ai_openrouter_model }}
AUTO_PR_OPENROUTER_HTTP_REFERER: ${{ inputs.ai_openrouter_http_referer }}
AUTO_PR_OPENROUTER_TITLE: ${{ inputs.ai_openrouter_title }}
GH_TOKEN: ${{ secrets.GH_TOKEN || github.token }}
```

Add workflow inputs:

- `ai_openrouter_model`, default `""`
- `ai_openrouter_http_referer`, default `""`
- `ai_openrouter_title`, default `""`

Existing local llama inputs remain unchanged.

Do not use `secrets.OPENROUTER_API_KEY` directly in a job-level or step-level `if:` expression.
GitHub documents that secrets are not directly usable in `if:` conditionals. When a conditional
skip is needed, copy the secret to an environment variable and test the environment variable.

### CI Integration Workflow

Replace `integration-github-models` with `integration-openrouter`.

The real OpenRouter integration should run only when `OPENROUTER_API_KEY` is present:

- In scheduled CI, set repository/org secret if real cloud integration is desired.
- In local integration tests, export `OPENROUTER_API_KEY`.
- Keep mocked unit tests as the required coverage path so public fork CI does not require secrets.
- Preserve the existing behavior that the real cloud integration does not run in required PR/push
  `workflow_call` CI. Gate it to `workflow_dispatch` or `schedule`, then skip the OpenRouter test
  step when the environment-projected `OPENROUTER_API_KEY` value is blank.
- Remove `models: read` from the `ci.yml` callers and from all integration jobs, including local
  llama integration jobs. None of the post-migration integration jobs need GitHub Models access.

`.env.ci` should contain:

```dotenv
INTEGRATION_OPENROUTER_MODEL=openai/gpt-oss-20b:free
```

Do not store `OPENROUTER_API_KEY` in `.env.ci`.

## Documentation Changes

Update:

- `docs/INTEGRATION.md`
- `docs/TROUBLESHOOTING.md`
- `docs/WORKFLOW_SECURITY.md`
- `docs/ARCHITECTURE.md`
- `docs/CI.md`
- `docs/PR_TEMPLATE.md` if provider wording appears there
- website copied docs tests if generated docs paths or provider text change

Required documentation points:

- GitHub Models was retired on 2026-07-30.
- OpenRouter is the default cloud provider.
- Users need an `OPENROUTER_API_KEY` secret for stock cloud generation.
- Free model IDs must use `vendor/model:free` unless explicitly using `openrouter/free`.
- OpenRouter free quotas can produce `429`; the job may fall back to commit-derived content.
- `models: read` is no longer required.
- `GH_TOKEN` is still relevant for GitHub PR lookup/create operations but not cloud inference.

## Backward Compatibility

Breaking change:

- `github-models` stops being a valid provider because the upstream service is retired.

Compatibility preserved:

- `local` provider env and workflow inputs remain valid.
- Routing decision JSON remains structurally similar.
- PR title/body artifacts remain unchanged.
- The create workflow remains unchanged except docs/security references.
- Single-commit PR generation remains AI-free and unaffected.

Migration path for adopters:

1. Create an OpenRouter API key.
2. Add repository or organization secret `OPENROUTER_API_KEY`.
3. Update custom workflows from `ai_provider: github-models` to `ai_provider: openrouter`.
4. Remove `models: read` permissions from custom generate jobs.
5. Replace any GitHub model IDs with OpenRouter free IDs such as `openai/gpt-oss-20b:free`.
6. Keep local llama configuration unchanged if using `ai_provider: local`.

## Security And Trust Boundary

The generate workflow remains unprivileged and checks out untrusted branch code by immutable SHA. Passing `OPENROUTER_API_KEY` into this job is still an external secret exposure to branch code. The risk profile resembles the retired GitHub Models `GH_TOKEN` inference-token pattern, but the blast radius changes:

- The key can spend or consume OpenRouter quota according to the user's key settings.
- The key is not a GitHub repository token and does not grant repository write access.
- Users should set OpenRouter key limits in OpenRouter.
- Docs should recommend a dedicated low-limit key for auto-pr.

The privileged create workflow remains separate, default-branch-only, and artifact-based. This migration must not introduce a privileged checkout or branch-derived executable handoff.

## Testing Strategy

### Unit Tests

Update or add tests for:

- config parses `openrouter`
- config rejects `github-models` with retirement message
- config requires `OPENROUTER_API_KEY` for `openrouter`
- config accepts and trims `AUTO_PR_OPENROUTER_MODEL`
- config rejects non-free OpenRouter model IDs
- AI provider layer builds OpenRouter client with API URL, bearer auth, and attribution headers
- AI provider layer rejects empty OpenRouter key/model
- OpenRouter catalog parser handles valid, malformed, missing, and non-free entries
- OpenRouter model selection prefers free tool-capable models for tool routes
- OpenRouter model selection falls back to static free model when catalog is unavailable
- run config maps OpenRouter provider through `runGeneratePrContent`
- retired GitHub provider fails before network calls

### Workflow Tests

Update workflow tests to assert:

- default reusable `ai_provider` is `openrouter`
- `models: read` is absent from generate jobs
- `OPENROUTER_API_KEY` is declared as an optional reusable-workflow secret
- `OPENROUTER_API_KEY` is passed only when `ai_provider == 'openrouter'`
- the routing-context and generate-content steps both receive the OpenRouter env they need
- local llama conditions still use `ai_provider == 'local'`
- stock `auto-pr.yml` includes `strategy.max-parallel: 2`
- workflow YAML does not reference `secrets.OPENROUTER_API_KEY` directly inside `if:`

### Integration Tests

Rename the real cloud integration test:

- from `test/integration/ai-providers.github-models.integration.test.ts`
- to `test/integration/ai-providers.openrouter.integration.test.ts`

Skip unless `OPENROUTER_API_KEY` is set. Use `INTEGRATION_OPENROUTER_MODEL`, defaulting in `.env.ci` to `openai/gpt-oss-20b:free`.

Keep local fallback and local happy-path integration tests unchanged.

### Full Check

Final implementation must pass:

```bash
bun run check
```

## Rollout

Implementation should be split into reviewable commits:

1. Add OpenRouter core selection and catalog parsing.
2. Add OpenRouter config and AI provider wiring.
3. Replace generate routing/fallback orchestration.
4. Update workflows and CI integration.
5. Update docs and historical references.
6. Remove dead GitHub Models live/interface files after references are gone.

Each commit should keep the tree passing targeted tests for the changed area. The final branch must pass `bun run check`.

## Future Work

- Add an explicit paid OpenRouter opt-in policy with budget controls.
- Query `GET /api/v1/key` for quota diagnostics and clearer preflight warnings.
- Add user-configurable route preference lists.
- Add provider-neutral cloud routing if a second active cloud backend is introduced.
