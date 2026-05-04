# Dynamic GitHub Models Usage

**Date:** 2026-05-04  
**Status:** Proposed  
**Companion specs:** [Inference and routing](2026-03-29-auto-pr-inference-and-routing.md), [Effect toolkit](2026-03-29-auto-pr-effect-toolkit-design.md)

## Summary

`github-models` should stop relying on static model ids and static tool payload caps. The generate workflow should discover GitHub Models catalog metadata, infer the best available account limit profile, choose a model that fits the PR and the account, and derive request/tool budgets from the selected model.

The core rule: PR size decides the requested envelope, GitHub APIs decide the allowed envelope, and generation uses the smaller of the two.

## Current State

Implemented today:

- `src/core/model-routing.ts` classifies PR complexity into a model band, tool strategy, reasoning need, and static model id.
- `src/workflow/auto-pr-build-model-routing-context.ts` writes `selected_model`, `tool_strategy`, and `routing_context` to `GITHUB_OUTPUT`.
- `src/workflow/auto-pr-generate-content.ts` computes `toolRoundLimit` and `tokenBudget` from commit count, changed file count, and prompt size.
- `src/core/sanitize-diff.ts` hard-caps AI tool response text at `8_000` chars, independent of selected model.

This is deterministic, but it does not use live GitHub Models metadata or account limits.

## GitHub API Evidence

### Model Catalog

GitHub documents `GET https://models.github.ai/catalog/models` as the Models catalog endpoint. It returns model ids, capabilities, supported modalities, `limits.max_input_tokens`, `limits.max_output_tokens`, and `rate_limit_tier`. The example includes `openai/gpt-4.1`, `tool-calling`, `max_input_tokens`, `max_output_tokens`, and `rate_limit_tier: "high"`.

Source: [REST API endpoints for Models catalog](https://docs.github.com/en/rest/models/catalog)

Use this endpoint to decide:

- Whether a model supports text output.
- Whether it supports tool calls.
- The catalog-level max input/output token limits.
- The documented rate limit tier used by GitHub's free API limit table.

### GitHub Models Free API Limits

GitHub documents free API limits by model class and Copilot plan. The table includes requests per minute, requests per day, tokens per request, and concurrent requests for low, high, embedding, and named special-case model groups. The same page says paid usage moves to production-grade rate limits, and the free limits are subject to change.

Source: [Prototyping with AI models - Rate limits](https://docs.github.com/en/github-models/use-github-models/prototyping-with-ai-models#rate-limits)

Use this page as a local policy table, not as live data. There is no documented endpoint that returns the effective GitHub Models RPM/RPD/concurrency cap for the current token and model.

### Account And Organization Plan Signals

`GET /user` returns a `plan` object in GitHub's response example. OAuth classic tokens need `user` scope for private profile information; fine-grained tokens work without extra permissions for this endpoint.

Source: [REST API endpoints for users - Get the authenticated user](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)

`GET /orgs/{org}` can expose organization plan information, but full details require org owner access. GitHub Apps need the `Organization plan` permission to see an organization's GitHub plan.

Source: [REST API endpoints for organizations - Get an organization](https://docs.github.com/en/rest/orgs/orgs#get-an-organization)

These endpoints help determine whether the account or org is on GitHub Free, Team, Pro, or Enterprise. They do not by themselves determine GitHub Models free API limits, because GitHub Models free limits vary by Copilot plan.

### Copilot Plan Signals

`GET /orgs/{org}/copilot/billing` returns organization Copilot subscription data, including `plan_type`, with examples such as `business`. The endpoint is public preview, requires owner-level visibility, and needs `manage_billing:copilot` or `read:org` for classic tokens, or fine-grained organization permissions such as `GitHub Copilot Business` read or `Administration` read.

Source: [REST API endpoints for Copilot user management](https://docs.github.com/en/rest/copilot/copilot-user-management#get-copilot-seat-information-and-settings-for-an-organization)

Use this endpoint for organization-owned repositories when permissions are present. It can identify `business` and `enterprise` Copilot plans.

For individual Copilot Free vs Pro, no documented REST endpoint in the researched GitHub docs clearly returns a direct personal Copilot `plan_type`. User billing usage endpoints expose premium request usage, but not an explicit personal Copilot plan name.

### Billing, Budgets, And Usage

GitHub documents organization budget APIs and billing usage APIs. Budget endpoints require organization admin or billing manager access and are public preview. Premium request usage endpoints can filter by model and product and have user and organization variants.

Sources:

- [REST API endpoints for Billing budgets](https://docs.github.com/en/rest/billing/budgets)
- [REST API endpoints for Billing usage](https://docs.github.com/en/rest/billing/usage)
- [GitHub Models billing](https://docs.github.com/en/billing/concepts/product-billing/github-models)

Use billing and usage APIs for observability and guardrails when permissions are available. Do not make them required for normal PR generation.

## Design Decision

Recommended approach: live catalog plus best-effort account profile plus conservative policy fallback.

Alternatives considered:

| Approach | Result |
|----------|--------|
| Static allowlist only | Simple, but it keeps breaking when GitHub changes model caps or catalog availability. |
| Live catalog only | Better model selection, but still misses free-tier token/request caps because the catalog does not include the user's effective plan. |
| Live catalog + account profile + policy fallback | Best fit. It uses official APIs where available and remains deterministic when permissions are missing. |

## Architecture

Keep FC/IS boundaries:

- Pure core decides budgets and model choice from explicit inputs.
- Live services fetch GitHub catalog, plan, billing, and usage data.
- Workflow orchestration calls live services before `generate-content`.
- `generate-content` receives resolved model and envelope env/config; it does not fetch catalog data itself.

### New Data Model

Add pure types in `src/core/github-model-routing.ts`:

```ts
export type GithubModelsPlanClass =
	| "copilot-free"
	| "copilot-pro"
	| "copilot-business"
	| "copilot-enterprise"
	| "paid-usage"
	| "unknown";

export type GithubModelsRateLimitTier =
	| "low"
	| "high"
	| "embedding"
	| "azure-openai-o1-preview"
	| "azure-openai-o1-o3-gpt5"
	| "azure-openai-mini"
	| "deepseek-r1"
	| "xai-grok-3"
	| "xai-grok-3-mini"
	| "unknown";

export type GithubModelCatalogEntry = {
	readonly id: string;
	readonly name: string;
	readonly capabilities: readonly string[];
	readonly supportedInputModalities: readonly string[];
	readonly supportedOutputModalities: readonly string[];
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
	readonly rateLimitTier: GithubModelsRateLimitTier;
};

export type GithubModelsRequestEnvelope = {
	readonly model: string;
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
	readonly requestedInputTokens: number;
	readonly requestedOutputTokens: number;
	readonly tokenBudget: number;
	readonly toolRoundLimit: number;
	readonly toolResponseCharBudget: number;
	readonly rateLimitTier: GithubModelsRateLimitTier;
	readonly planClass: GithubModelsPlanClass;
	readonly source: "catalog-and-plan" | "catalog-only" | "static-fallback" | "explicit-model";
};
```

### Live Services

Add interfaces in `src/auto-pr/interfaces/`:

- `GithubModelsCatalogClient`
- `GithubAccountProfileClient`
- `GithubModelsBillingClient`

Add live implementations in `src/auto-pr/live/` using `FetchHttpClient` and Effect Schema decoders:

- Catalog client calls `https://models.github.ai/catalog/models`.
- Account profile client calls `/user`, `/repos/{owner}/{repo}` if repository owner detection is needed, `/orgs/{org}`, and `/orgs/{org}/copilot/billing`.
- Billing client calls budget and premium request usage endpoints only when explicitly enabled or when permissions are already available.

All live clients must degrade to `unknown` profile on `403`, `404`, or preview endpoint gaps. Authentication failures for inference still remain hard config errors; discovery failures should not block PR generation.

### Plan Detection Policy

Effective plan detection order:

1. Explicit env override: `AUTO_PR_GITHUB_MODELS_PLAN_CLASS`.
2. Org Copilot endpoint for organization repositories: map `plan_type=business` to `copilot-business`, `plan_type=enterprise` to `copilot-enterprise`.
3. Paid usage/budget signal: if budget or usage APIs show paid premium request usage and the endpoint is readable, use `paid-usage`.
4. User and org account plan: record GitHub account plan for diagnostics, but do not treat it as the Copilot plan unless no better signal exists.
5. Fallback: `unknown`, treated as `copilot-free` for request safety.

This means free-tier can be determined for the GitHub account itself when `/user.plan` or `/org.plan` is visible. It cannot always be proven for GitHub Models limits, because those limits are keyed to Copilot plan and GitHub does not document a direct personal Copilot Free/Pro plan endpoint.

### Rate Limit Policy Table

Encode GitHub's documented free API rate limit table as pure data:

```ts
export type GithubModelsFreeLimit = {
	readonly requestsPerMinute: number | "not-applicable";
	readonly requestsPerDay: number | "not-applicable";
	readonly inputTokensPerRequest: number | "not-applicable";
	readonly outputTokensPerRequest: number | "not-applicable";
	readonly concurrentRequests: number | "not-applicable";
};
```

The policy table should mirror the docs categories:

- Low
- High
- Embedding
- Azure OpenAI o1-preview
- Azure OpenAI o1, o3, and gpt-5
- Azure OpenAI o1-mini, o3-mini, o4-mini, gpt-5-mini, gpt-5-nano, and gpt-5-chat
- DeepSeek-R1 family
- xAI Grok-3
- xAI Grok-3-Mini

For unknown model tiers, use the stricter high-model free profile for text generation.

### Model Selection

Model choice should rank candidates with text output and, when `requiresToolCalls` is true, `tool-calling` capability.

Selection input:

- Existing PR signals from `ModelBandSignals`.
- Existing `toolStrategy`, `reasoningNeed`, and `requiresToolCalls`.
- Catalog entries.
- Effective plan class.
- Existing explicit model override.

Selection rules:

- Explicit model wins if it exists in the catalog or catalog lookup failed.
- For band A, prefer low-tier text models with enough request budget.
- For band B, prefer text models with tool calling when the tool strategy is not `none`; otherwise prefer low-tier capable models.
- For band C, prefer stronger tool-capable text models that fit the model and account envelope.
- Avoid embedding-only entries.
- Avoid models whose free-tier token/request envelope cannot fit the initial prompt plus minimum completion.
- If no model fits, downshift tool strategy and payload budgets before changing provider or failing.

### Request Envelope

Compute in pure core:

```ts
export type RequestedEnvelopeInput = {
	readonly promptChars: number;
	readonly commitCount: number;
	readonly changedFileCount: number;
	readonly sourceChurn: number;
	readonly toolStrategy: ToolStrategy;
	readonly reasoningNeed: ReasoningNeed;
};
```

Requested envelope:

- Estimate prompt tokens from chars.
- Add reserved JSON completion budget.
- Add per-tool-round budget based on tool strategy.
- Increase rounds for high spread or commit-heavy PRs.

Allowed envelope:

- Start from catalog `limits.max_input_tokens` and `limits.max_output_tokens`.
- Clamp to documented free API tokens-per-request for the detected plan and `rate_limit_tier`.
- If plan class is `paid-usage`, use catalog limits and keep local safety caps.
- If plan class is `unknown`, use `copilot-free`.

Final envelope:

- `inputTokenBudget = min(requestedInput, allowedInput)`
- `outputTokenBudget = min(requestedOutput, allowedOutput)`
- `toolRoundLimit = min(requestedRounds, roundLimitForRateProfile)`
- `toolResponseCharBudget = tokenToCharBudget(remainingInputBudgetForToolResults)`

### Dynamic Tool Response Payload

Replace `MAX_AI_TOOL_ROUNDTRIP_DIFF_CHARS = 8_000` with an envelope-driven value.

New behavior:

- `DiffToolkit` receives `toolResponseCharBudget`.
- `capDiffForAiToolRoundtrip(diff, budget)` caps each tool response based on the selected model and account envelope.
- For very small free-tier envelopes, cap full diff responses aggressively and push the model toward `hotspot` or `commit-diff`.
- For large paid/catalog envelopes, allow larger responses but still keep a hard project maximum to avoid pathological git diffs.

Suggested hard ceiling: `32_000` chars per tool response unless a future implementation proves larger responses are reliable across providers.

### Workflow Outputs

Extend `auto-pr-build-model-routing-context` outputs:

- `selected_model`
- `tool_strategy`
- `reasoning_need`
- `requires_tool_calls`
- `token_budget`
- `tool_round_limit`
- `tool_response_char_budget`
- `github_models_plan_class`
- `github_models_rate_limit_tier`
- `github_models_envelope_source`
- `routing_context`

Pass routing outputs into `generate-content` as trusted internal workflow context.
Do not expose token/round/tool-budget values as user-facing override env vars.
These values are derived automatically from routing signals, catalog metadata, and
best-effort account-plan detection.

Keep old defaults for local and custom OpenAI-compatible providers.

## Failure Modes

| Failure | Behavior |
|---------|----------|
| Catalog fetch fails | Use current static model defaults and static conservative envelope. |
| Catalog schema changes | Decode known fields, ignore extras, fallback on missing required fields. |
| Org/user plan fetch forbidden | Use `unknown` plan class, treated as `copilot-free`. |
| Explicit model not in catalog | Keep explicit model, apply conservative high-tier free limits. |
| Model lacks tool calling | If tools are required, select another model; if explicit model was set, disable tools and log warning. |
| Request too large still occurs | Retry once with halved tool response budget and reduced tool strategy, then fall back to commit-derived PR content. |

## Security

- The generate job already checks out branch code in an unprivileged context. Discovery uses the same `models: read` token path.
- Do not log token values or billing details beyond plan class, model id, tier, and coarse source.
- Do not let branch content choose arbitrary endpoint URLs or models. Catalog ids and explicit workflow inputs are the only accepted model ids.
- Treat billing endpoints as optional because they require broader permissions than model inference.

## Testing Strategy

Core tests:

- Catalog decoding accepts GitHub's documented example shape.
- Plan classification maps org Copilot `business` and `enterprise`.
- Unknown or inaccessible plan maps to conservative `copilot-free`.
- Free limit table returns documented input/output caps for low/high/free/pro/business/enterprise combinations.
- Model selection filters out non-text and non-tool-capable entries when tools are required.
- Envelope clamps requested PR budget against model catalog limits and free API limits.
- Tool response char budget grows and shrinks with selected envelope.

Workflow tests:

- `auto-pr-build-model-routing-context` emits new outputs.
- Explicit model override still wins.
- Catalog fetch failure preserves existing static routing behavior.
- GitHub Models provider passes envelope env vars into `generate-content`.

Generate-content tests:

- Env/config parsing accepts token/tool budget overrides.
- `DiffToolkit` applies dynamic char budget.
- Simulated small free-tier envelope avoids second-round request overflow.

Integration tests:

- Keep real GitHub Models catalog/inference tests optional and manual/nightly.
- Add mock HTTP tests for catalog, org Copilot billing, and billing usage endpoints.

## Implementation Plan

### Phase 1: Pure Core

1. Create `src/core/github-model-routing.ts`.
2. Add catalog, plan, rate-limit, and envelope types.
3. Add a pure rate-limit table from GitHub docs.
4. Add pure model candidate filtering and ranking.
5. Add pure envelope derivation and clamping.
6. Add tests in `test/core/github-model-routing.test.ts`.

### Phase 2: Live GitHub Metadata Clients

1. Create interfaces under `src/auto-pr/interfaces/`.
2. Create live clients under `src/auto-pr/live/`.
3. Decode responses with Effect Schema.
4. Treat discovery failures as typed recoverable errors.
5. Add unit tests with mocked fetch responses.

### Phase 3: Routing Command Integration

1. Inject metadata clients into `auto-pr-build-model-routing-context`.
2. Fetch catalog/profile only for `provider=github-models` and no explicit static opt-out.
3. Compute final model and envelope in pure core.
4. Write the new outputs to `GITHUB_OUTPUT`.
5. Update routing context text with plan class, rate tier, and envelope source.
6. Add workflow command tests.

### Phase 4: Generate Content And Tool Budgets

1. Extend config to read optional envelope env vars.
2. Pass envelope overrides into `generatePrContent`.
3. Change `capDiffForAiToolRoundtrip` to accept a budget argument.
4. Pass dynamic budget into `makeDiffToolkitLayer`.
5. Add tests for dynamic truncation and request overflow prevention.

### Phase 5: Workflow And Docs

1. Update `.github/actions/auto-pr-run-command/action.yml` outputs.
2. Update `.github/workflows/auto-pr-generate-reusable.yml` env wiring.
3. Update `docs/INTEGRATION.md`, `docs/TROUBLESHOOTING.md`, and `docs/ARCHITECTURE.md`.
4. Add or update ADR if the implementation introduces new public behavior or permissions.
5. Run `bun run check`.

## Implementation Defaults

1. Add an opt-out input/env pair: workflow input `github_models_dynamic_routing` defaults to `true`; env `AUTO_PR_GITHUB_MODELS_DYNAMIC_ROUTING=0` disables live catalog/profile discovery.
2. Attempt catalog and org/user plan discovery by default. Attempt billing budget and premium request usage APIs only when `AUTO_PR_GITHUB_MODELS_BILLING_DISCOVERY=1` because those APIs need broader billing/admin permissions.
3. Support `AUTO_PR_GITHUB_MODELS_PLAN_CLASS` for personal Copilot Pro and other cases GitHub does not expose through the documented APIs available to the generate job.

## Self-Review

- No implementation step depends on undocumented GitHub endpoints.
- The spec distinguishes GitHub account plan from Copilot plan because GitHub Models free limits are keyed to Copilot plan.
- Discovery failures degrade to current behavior instead of blocking PR creation.
- Tool response payload is model/account-envelope driven, with a hard project ceiling for reliability.
