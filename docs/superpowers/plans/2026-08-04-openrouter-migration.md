# OpenRouter Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the retired `github-models` cloud provider with `openrouter`, using OpenRouter free-tier model IDs by default, while preserving the existing `local` OpenAI-compatible provider and the generate/create workflow trust boundary.

**Architecture:** Keep provider policy and model-selection math in `src/core`, HTTP catalog access in `src/auto-pr/live`, provider-layer construction in `src/auto-pr/live/ai-provider.ts`, and generation orchestration in `src/workflow/auto-pr-generate-content.ts`. The active provider union becomes `local | openrouter`; `github-models` remains only in historical docs/specs and in an early config error that tells users why the provider no longer works.

**Tech Stack:** TypeScript, Effect v4 beta, Bun tests, `@effect/ai-openai-compat`, GitHub Actions reusable workflows, rumdl/typos documentation checks.

**Global Constraints:**

- Implement against the approved design spec: [2026-08-04-openrouter-migration-design.md](../specs/2026-08-04-openrouter-migration-design.md).
- Do not add `@openrouter/sdk`; OpenRouter is OpenAI-compatible and the repo already uses `@effect/ai-openai-compat`.
- Do not use paid OpenRouter models in this migration. Configured cloud models must be `vendor/model:free` or the explicit router ID `openrouter/free`.
- Do not use `GH_TOKEN` for cloud inference after this migration. `GH_TOKEN` remains for GitHub API operations only.
- Do not keep `github-models` as a working alias. Fail early with the retirement date and replacement guidance.
- Preserve `local` provider behavior, local llama workflow paths, and single-commit AI-free PR generation.
- Preserve ADR 0016’s trust boundary: unprivileged generate job, privileged create job, artifact handoff, immutable head SHA checkout.
- Do not expose `OPENROUTER_API_KEY` to branch-controlled executable code. Secret-bearing OpenRouter
  steps may read the checked-out branch as data, but must execute trusted auto-pr code from an
  immutable package/action source.
- Do not commit generated `dist/`; restore it before committing if `bun run check` updates it.
- Every task below ends with a commit. If a task must be split for review clarity, use more commits with the same conventional prefix.

## OpenRouter Documentation Facts Used By This Plan

Use these facts while implementing. Re-check the URLs when model policy behavior appears stale.

- GitHub retired GitHub Models on 2026-07-30, including the playground, model catalog, inference API, and BYOK: <https://github.blog/changelog/2026-07-30-github-models-is-now-retired/>.
- OpenRouter exposes an OpenAI-compatible chat endpoint at `https://openrouter.ai/api/v1/chat/completions`: <https://openrouter.ai/docs/quickstart>.
- OpenRouter requests authenticate with `Authorization: Bearer <OPENROUTER_API_KEY>` and can use the OpenAI SDK by setting the base URL to `https://openrouter.ai/api/v1`: <https://openrouter.ai/docs/api-reference/authentication>.
- Optional attribution headers are `HTTP-Referer` and `X-OpenRouter-Title`; use them only for OpenRouter calls and never require them for generation: <https://openrouter.ai/docs/features/app-attribution>.
- The model catalog is available through `GET /api/v1/models`; catalog entries include `id`,
  `pricing`, `context_length`, `architecture`, `supported_parameters`, and `expiration_date`:
  <https://openrouter.ai/docs/guides/overview/models>.
- `architecture.output_modalities` identifies supported output types. The OpenRouter models API also
  supports an `output_modalities=text` filter, and auto-pr should require text output:
  <https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties>.
- `supported_parameters` identifies supported request parameters. For tool routes, require both
  `tools` and `tool_choice`: <https://openrouter.ai/docs/guides/features/tool-calling>.
- OpenRouter pricing fields can include prompt, completion, request, image, audio, web search,
  internal reasoning, cache reads/writes, and conditional `pricing.overrides`. Treat any non-zero or
  unknown chargeable price as non-free: <https://openrouter.ai/docs/guides/overview/models>.
- The free router ID is `openrouter/free`; it routes to free models matching request requirements, but the exact model can change and should be inspected from the response `model` field when needed: <https://openrouter.ai/docs/guides/routing/routers/free-router>.
- OpenRouter also supports direct free model IDs that end with `:free`, such as `vendor/model:free`: <https://openrouter.ai/docs/guides/routing/routers/free-router>.
- OpenRouter free-model availability changes frequently, so static defaults are fallbacks rather than an availability guarantee: <https://openrouter.ai/docs/guides/routing/routers/free-router>.
- OpenRouter API keys are bearer tokens and can have optional credit limits. Use a dedicated,
  low-limit key for auto-pr: <https://openrouter.ai/docs/api-reference/authentication>.
- OpenRouter limits include credit limits and rate limits. `GET /api/v1/key` returns key metadata, limit fields, usage fields, and `is_free_tier`: <https://openrouter.ai/docs/api-reference/limits>.
- OpenRouter error responses use `{ error: { code, message, metadata } }`, and `error.metadata.error_type` is the stable error classifier across provider skins: <https://openrouter.ai/docs/api-reference/errors>.
- OpenRouter documents retry handling for `429` and `503`, including `Retry-After`: <https://openrouter.ai/docs/api-reference/errors> and <https://openrouter.ai/docs/api-reference/limits>.
- GitHub Actions does not automatically pass secrets to reusable workflows, and secrets cannot be directly referenced in `if:` conditionals: <https://docs.github.com/actions/security-guides/using-secrets-in-github-actions>.

Current catalog sample captured on 2026-08-04 with:

```bash
curl -fsS 'https://openrouter.ai/api/v1/models?limit=1000&supported_parameters=tools&sort=pricing-low-to-high'
```

Free, tool-capable entries included `openai/gpt-oss-20b:free`, `google/gemma-4-26b-a4b-it:free`, `cohere/north-mini-code:free`, multiple `nvidia/nemotron-3-*:*free` entries, and `poolside/laguna-*:*free` entries. Treat this as evidence for initial preferences only; the implementation must fetch and filter the live catalog.

---

## Task 1: Add OpenRouter core catalog parsing and model selection

**Files:**

- Add: `src/core/openrouter-routing.ts`
- Add: `test/core/openrouter-routing.test.ts`
- Modify: `src/core/model-routing.ts`
- Modify: `src/core/routing-artifacts.ts`
- Modify: `src/auto-pr/index.ts`
- Delete later, not in this task: `src/core/github-model-routing.ts`

### Steps

- [ ] **Step 1: Write failing parser and policy tests**

Add tests that define OpenRouter catalog fixtures in the OpenRouter wire shape:

```ts
const toolFreeModel = {
  id: "openai/gpt-oss-20b:free",
  name: "GPT OSS 20B",
  context_length: 131_072,
  expiration_date: null,
  pricing: {
    prompt: "0",
    completion: "0",
    request: "0",
    image: "0",
    web_search: "0",
    internal_reasoning: "0",
    input_cache_read: "0",
    input_cache_write: "0",
    overrides: [],
  },
  architecture: {
    input_modalities: ["text"],
    output_modalities: ["text"],
  },
  supported_parameters: ["tools", "tool_choice", "max_tokens"],
};

const textFreeModel = {
  id: "google/gemma-4-31b-it:free",
  name: "Gemma 4 31B",
  context_length: 262_144,
  expiration_date: null,
  pricing: {
    prompt: "0",
    completion: "0",
    request: "0",
    image: "0",
    web_search: "0",
    internal_reasoning: "0",
    input_cache_read: "0",
    input_cache_write: "0",
    overrides: [],
  },
  architecture: {
    input_modalities: ["text"],
    output_modalities: ["text"],
  },
  supported_parameters: ["max_tokens"],
};

test("parseOpenRouterModelCatalog keeps valid free models and skips malformed entries", () => {
  const parsed = parseOpenRouterModelCatalog({
    data: [
      toolFreeModel,
      textFreeModel,
      { id: "", pricing: { prompt: "0", completion: "0" } },
      { name: "missing id" },
    ],
  });

  expect(parsed.map((entry) => entry.id)).toEqual([
    "openai/gpt-oss-20b:free",
    "google/gemma-4-31b-it:free",
  ]);
  expect(parsed[0]?.contextLength).toBe(131_072);
  expect(parsed[0]?.expirationDate).toBeUndefined();
  expect(parsed[0]?.pricing.prompt).toBe(0);
  expect(parsed[0]?.pricing.completion).toBe(0);
  expect(parsed[0]?.pricing.request).toBe(0);
});
```

Add tests for:

- configured free model wins when it is catalog-feasible;
- configured free model is preserved as the fallback when catalog discovery is unavailable;
- configured paid model is rejected by `validateOpenRouterModelId`;
- tool routes require `tools` and `tool_choice`;
- text routes require `outputModalities.includes("text")`;
- expired `expiration_date` entries are infeasible;
- any non-zero or unknown chargeable price, including request/image/audio/web-search/reasoning/cache
  prices and conditional override prices, makes a catalog entry infeasible;
- static fallback returns `openai/gpt-oss-20b:free` when catalog is empty;
- the request envelope clamps budget to catalog context length.

Continue with the focused failure check:

- [ ] **Step 2: Run the focused test and confirm RED**

```bash
bun test test/core/openrouter-routing.test.ts
```

Expected: fail because `src/core/openrouter-routing.ts` does not exist.

- [ ] **Step 3: Implement core OpenRouter types and constants**

Create:

```ts
export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-oss-20b:free";
export const DEFAULT_OPENROUTER_TITLE = "auto-pr";

export type OpenRouterRouteClass =
  | "A-text-light"
  | "B-text-medium"
  | "B-tool-medium"
  | "C-text-strong"
  | "C-tool-strong";

export type OpenRouterModelCatalogEntry = {
  readonly id: string;
  readonly name: string;
  readonly contextLength: number;
  readonly supportedParameters: readonly string[];
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly expirationDate?: string;
  readonly pricing: OpenRouterModelPricing;
};

export type OpenRouterModelPricing = {
  readonly prompt: number | undefined;
  readonly completion: number | undefined;
  readonly request: number | undefined;
  readonly image: number | undefined;
  readonly imageOutput: number | undefined;
  readonly imageToken: number | undefined;
  readonly audio: number | undefined;
  readonly audioOutput: number | undefined;
  readonly webSearch: number | undefined;
  readonly internalReasoning: number | undefined;
  readonly inputCacheRead: number | undefined;
  readonly inputCacheWrite: number | undefined;
  readonly inputCacheWrite1h: number | undefined;
  readonly overrides: readonly OpenRouterModelPricingOverride[];
  readonly unknownPriceKeys: readonly string[];
};

export type OpenRouterModelPricingOverride = {
  readonly conditionKeys: readonly string[];
  readonly prices: Readonly<Record<string, number | undefined>>;
};

export type OpenRouterModelSelection = {
  readonly model: string;
  readonly requiresToolCalls: boolean;
  readonly selectionMode:
    | "configured"
    | "preferred"
    | "catalog"
    | "free-tool-fallback"
    | "free-text-fallback"
    | "static-fallback";
  readonly catalogEntry?: OpenRouterModelCatalogEntry;
};

export type CloudModelRequestEnvelope = {
  readonly provider: "openrouter";
  readonly model: string;
  readonly contextLength: number;
  readonly requestedInputTokens: number;
  readonly requestedOutputTokens: number;
  readonly tokenBudget: number;
  readonly toolRoundLimit: number;
  readonly toolResponseCharBudget: number;
  readonly source: "catalog" | "configured" | "static-fallback";
};
```

Use these route preferences:

```ts
export const OPENROUTER_FREE_MODEL_PREFERENCES: Record<
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

- [ ] **Step 4: Implement pure parsing and validation**

Implement these exports:

```ts
export function parseOpenRouterPrice(value: unknown): number | undefined;
export function normalizeOpenRouterPricing(rawPricing: unknown): OpenRouterModelPricing;
export function parseOpenRouterModelCatalog(raw: unknown): readonly OpenRouterModelCatalogEntry[];
export function validateOpenRouterModelId(model: string): Result.Result<string, OpenRouterModelIdError>;
export function isOpenRouterFreeModel(entry: OpenRouterModelCatalogEntry): boolean;
export function isOpenRouterModelExpired(expirationDate: string | undefined, now?: Date): boolean;
export function hasOnlyKnownZeroPrices(pricing: OpenRouterModelPricing): boolean;
export function modelSupportsTextOutput(entry: OpenRouterModelCatalogEntry): boolean;
export function modelSupportsToolCalls(entry: OpenRouterModelCatalogEntry): boolean;
```

Rules:

- accept catalog body `{ data: [...] }`;
- accept direct array input in tests;
- trim IDs and names;
- normalize `expiration_date` to `expirationDate`; absent or `null` becomes `undefined`, a valid
  future/current date is kept, a malformed non-empty date makes the entry infeasible;
- parse documented pricing keys with `Number.parseFloat`;
- preserve unknown pricing keys in `pricing.unknownPriceKeys` so free selection can reject them;
- parse `pricing.overrides` and reject the model if any override has an unknown or non-zero
  chargeable price;
- treat missing `context_length` as `8_000`;
- treat missing prices as unknown, not zero;
- reject catalog entries whose non-empty price parses to a non-finite number;
- lower-case modality and supported-parameter comparisons;
- implement text support as `outputModalities.includes("text")`;
- reject expired entries before catalog fallback selection;
- return `Result.fail` from `validateOpenRouterModelId` unless the trimmed model ends in `:free` or equals `openrouter/free`.

Continue with route selection:

- [ ] **Step 5: Implement route-class selection and envelope construction**

Implement:

```ts
export function resolveOpenRouterRouteClass(input: {
  readonly band: ModelBand;
  readonly requiresToolCalls: boolean;
}): OpenRouterRouteClass;

export function pickOpenRouterModelCatalogEntry(input: {
  readonly band: ModelBand;
  readonly configuredModel?: string;
  readonly entries: readonly OpenRouterModelCatalogEntry[];
  readonly requiresToolCalls: boolean;
}): OpenRouterModelSelection;

export function buildOpenRouterRequestEnvelope(input: {
  readonly model: string;
  readonly requested: RequestedEnvelopeInput;
  readonly catalogEntry?: OpenRouterModelCatalogEntry;
  readonly source: CloudModelRequestEnvelope["source"];
}): CloudModelRequestEnvelope;
```

Extract `RequestedEnvelopeInput`, token-estimation constants, `computeRequestedEnvelope`, and `deriveToolResponseCharBudget` from `github-model-routing.ts` into `openrouter-routing.ts` or a provider-neutral `src/core/cloud-model-envelope.ts`. Keep the public export available from `openrouter-routing.ts` so callers do not import a generic helper before a second cloud provider exists.

- [ ] **Step 6: Update active provider schemas**

Change active provider unions:

```ts
// src/core/model-routing.ts
export type ModelProvider = "local" | "openrouter";

// src/core/routing-artifacts.ts
const ModelProviderSchema = Schema.Union([
  Schema.Literal("local"),
  Schema.Literal("openrouter"),
]);
```

Do not allow `github-models` in `RoutingDecisionSchema`. Retired provider handling belongs in config parsing before schema decode.

- [ ] **Step 7: Run focused tests and commit**

```bash
bun test test/core/openrouter-routing.test.ts test/core/routing-artifacts.test.ts test/core/model-routing.test.ts
git add src/core/openrouter-routing.ts src/core/model-routing.ts src/core/routing-artifacts.ts src/auto-pr/index.ts test/core/openrouter-routing.test.ts
git commit -m "feat: add OpenRouter model routing core"
```

Expected: the focused tests pass. Existing GitHub-model tests may still fail until later tasks remove or rename them.

---

## Task 2: Add the OpenRouter models repository

**Files:**

- Add: `src/auto-pr/interfaces/openrouter-models-repository.ts`
- Add: `src/auto-pr/live/openrouter-models-repository.ts`
- Add: `test/auto-pr/openrouter-models-repository.test.ts`
- Modify: `src/auto-pr/index.ts`
- Delete later, not in this task: `src/auto-pr/interfaces/github-models-catalog-repository.ts`, `src/auto-pr/live/github-models-catalog-repository.ts`

### Steps

- [ ] **Step 1: Write failing live repository tests**

Use a mock `fetchImpl` and assert URL, headers, parse behavior, and failure degradation:

```ts
test("fetchModels calls OpenRouter models endpoint with bearer auth", async () => {
  const calls: Array<{ readonly url: string; readonly headers: HeadersInit | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      headers: init?.headers,
    });
    return Response.json({ data: [toolFreeModel] });
  };

  const layer = makeOpenRouterModelsRepositoryLive({ fetchImpl });
  await runEffect(Layer.mergeAll(TestBaseLayer, layer))(
    Effect.gen(function* () {
      const repo = yield* OpenRouterModelsRepository;
      const models = yield* repo.fetchModels(Redacted.make("sk-or-test", { label: "OPENROUTER_API_KEY" }));
      expect(models.map((model) => model.id)).toEqual(["openai/gpt-oss-20b:free"]);
      expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/models?limit=1000");
      expect(new Headers(calls[0]?.headers).get("authorization")).toBe("Bearer sk-or-test");
    }),
  );
});

test("fetchModels returns empty array on non-2xx and parse errors", async () => {
  const layer = makeOpenRouterModelsRepositoryLive({
    fetchImpl: async () => new Response("bad", { status: 503 }),
  });

  await runEffect(Layer.mergeAll(TestBaseLayer, layer))(
    Effect.gen(function* () {
      const repo = yield* OpenRouterModelsRepository;
      expect(yield* repo.fetchModels(Redacted.make("sk-or-test"))).toEqual([]);
    }),
  );
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

```bash
bun test test/auto-pr/openrouter-models-repository.test.ts
```

Expected: fail because the service files do not exist.

- [ ] **Step 3: Implement the interface and live layer**

Interface:

```ts
export interface OpenRouterModelsRepositoryService {
  readonly fetchModels: (
    apiKey: Redacted.Redacted<string>,
  ) => Effect.Effect<readonly OpenRouterModelCatalogEntry[], never, never>;
}
```

Live layer:

```ts
const OPENROUTER_MODELS_FETCH_TIMEOUT = "5 seconds";

export const OpenRouterModelsRepository =
  Context.Service<OpenRouterModelsRepositoryService>("OpenRouterModelsRepository");

export const makeOpenRouterModelsRepositoryLive = (
  options: { readonly fetchImpl?: typeof fetch } = {},
) =>
  Layer.succeed(OpenRouterModelsRepository, {
    fetchModels: (apiKey) =>
      Effect.tryPromise({
        try: async (signal) => {
          const response = await (options.fetchImpl ?? fetch)(
            `${OPENROUTER_API_URL}/models?limit=1000`,
            {
              method: "GET",
              signal,
              headers: {
                accept: "application/json",
                authorization: `Bearer ${Redacted.value(apiKey)}`,
              },
            },
          );
          if (!response.ok) return [];
          return parseOpenRouterModelCatalog((await response.json()) as unknown);
        },
        catch: () => [],
      }).pipe(
        Effect.timeout(OPENROUTER_MODELS_FETCH_TIMEOUT),
        Effect.catch(() => Effect.succeed([])),
      ),
  });
```

Keep auth optional only at the HTTP level if OpenRouter allows unauthenticated catalog reads later. The service still accepts the API key because generate already requires one for inference and this keeps a consistent access path.

- [ ] **Step 4: Export the repository service**

Update `src/auto-pr/index.ts` to export:

```ts
export type { OpenRouterModelsRepositoryService } from "#auto-pr/interfaces/openrouter-models-repository.js";
export {
  OpenRouterModelsRepository,
  OpenRouterModelsRepositoryLive,
  makeOpenRouterModelsRepositoryLive,
} from "#auto-pr/live/openrouter-models-repository.js";
```

- [ ] **Step 5: Run focused tests and commit**

```bash
bun test test/auto-pr/openrouter-models-repository.test.ts
git add src/auto-pr/interfaces/openrouter-models-repository.ts src/auto-pr/live/openrouter-models-repository.ts src/auto-pr/index.ts test/auto-pr/openrouter-models-repository.test.ts
git commit -m "feat: add OpenRouter model catalog repository"
```

Expected: repository tests pass and no secret value is asserted or logged outside the mock boundary.

---

## Task 3: Replace GitHub Models config and provider-layer wiring

**Files:**

- Modify: `src/auto-pr/config.ts`
- Modify: `src/auto-pr/ai-provider-config.ts`
- Modify: `src/auto-pr/live/ai-provider.ts`
- Modify: `src/auto-pr/index.ts`
- Modify: `test/auto-pr/config.test.ts`
- Modify: `test/auto-pr/ai-provider-config.test.ts`
- Modify: `test/auto-pr/ai-provider.test.ts`
- Modify: `test/workflow/run-auto-pr.test.ts`

### Steps

- [ ] **Step 1: Write failing config tests**

Replace the `github-models` config tests with OpenRouter tests:

```ts
test("openrouter uses routing decision, key, model, and attribution config", async () => {
  const providerLayer = ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      ...generatePrContentBaseEnv,
      AUTO_PR_AI_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "sk-or-test",
      AUTO_PR_OPENROUTER_MODEL: " openai/gpt-oss-20b:free ",
      AUTO_PR_OPENROUTER_HTTP_REFERER: " https://github.com/knirski/auto-pr ",
      AUTO_PR_OPENROUTER_TITLE: " auto-pr tests ",
      AUTO_PR_ROUTING_DECISION_JSON:
        '{"provider":"openrouter","selectedModel":"openai/gpt-oss-20b:free","requiresToolCalls":true,"tokenBudget":9000,"toolRoundLimit":4,"toolResponseCharBudget":1500}',
    }),
  );

  const layer = Layer.mergeAll(
    TestBaseLayer,
    GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
  );

  await runEffect(layer)(
    Effect.gen(function* () {
      const config = yield* GeneratePrContentConfig;
      expect(config.provider).toBe("openrouter");
      if (config.provider !== "openrouter") return expect().fail("expected openrouter");
      expect(config.model).toBe("openai/gpt-oss-20b:free");
      expect(config.openRouterHttpReferer).toBe("https://github.com/knirski/auto-pr");
      expect(config.openRouterTitle).toBe("auto-pr tests");
      expect(Redacted.isRedacted(config.openRouterApiKey)).toBe(true);
      expect(config.aiTokenBudget).toBe(9000);
      expect(config.aiToolRoundLimit).toBe(4);
      expect(config.aiToolResponseCharBudget).toBe(1500);
    }),
  );
});

test("rejects retired github-models provider with migration message", async () => {
  const providerLayer = ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      ...generatePrContentBaseEnv,
      AUTO_PR_AI_PROVIDER: "github-models",
    }),
  );

  const exit = await Effect.runPromise(
    GeneratePrContentConfig.pipe(
      Effect.provide(GeneratePrContentConfigLayer),
      Effect.provide(providerLayer),
      Effect.provide(TestBaseLayer),
      Effect.exit,
    ),
  );

  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    Result.match(Cause.findError(exit.cause), {
      onSuccess: (err) =>
        expect(String((err as AutoPrConfigError).missing.join(" "))).toContain(
          "GitHub Models was retired on 2026-07-30; use openrouter or local",
        ),
      onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
    });
  }
});
```

Add tests for:

- missing `OPENROUTER_API_KEY` when provider is `openrouter`;
- blank OpenRouter attribution title defaults to `auto-pr`;
- CR/LF in attribution header values fails config;
- non-free `AUTO_PR_OPENROUTER_MODEL=openai/gpt-5.2` fails with a paid-model message;
- `RunAutoPrConfigLayer` maps OpenRouter fields.

Continue with provider-layer coverage:

- [ ] **Step 2: Write failing provider-layer tests**

Update `test/auto-pr/ai-provider.test.ts`:

```ts
test("openrouter: sends OpenRouter base URL, bearer key, and attribution headers", async () => {
  const requests: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    return Response.json({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1,
      model: "openai/gpt-oss-20b:free",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    });
  };

  const layer = Layer.mergeAll(
    BaseLayer,
    aiProviderLayerFromConfig(
      {
        provider: "openrouter",
        model: "openai/gpt-oss-20b:free",
        apiKey: Redacted.make("sk-or-test", { label: "OPENROUTER_API_KEY" }),
        httpReferer: "https://github.com/knirski/auto-pr",
        title: "auto-pr",
      },
      { fetch: fetchImpl },
    ),
  );

  await runEffect(layer)(
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel;
      yield* model.generateText({ prompt: "Say ok" });
    }).pipe(Effect.scoped),
  );

  const request = requests[0];
  expect(request?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(request?.headers.get("authorization")).toBe("Bearer sk-or-test");
  expect(request?.headers.get("http-referer")).toBe("https://github.com/knirski/auto-pr");
  expect(request?.headers.get("x-openrouter-title")).toBe("auto-pr");
});
```

Add provider-layer failure tests for empty OpenRouter key and empty model. Keep local tests unchanged.

- [ ] **Step 3: Run focused tests and confirm RED**

```bash
bun test test/auto-pr/config.test.ts test/auto-pr/ai-provider-config.test.ts test/auto-pr/ai-provider.test.ts test/workflow/run-auto-pr.test.ts
```

Expected: fail on `openrouter` type/config references.

- [ ] **Step 4: Update provider config types**

In `src/auto-pr/config.ts`:

```ts
export type AiProvider = "local" | "openrouter";

export type GeneratePrContentConfigOpenRouter = GeneratePrContentConfigCommon & {
  readonly provider: "openrouter";
  readonly openRouterApiKey: Redacted.Redacted<string>;
  readonly openRouterModel?: string;
  readonly openRouterHttpReferer?: string;
  readonly openRouterTitle: string;
  readonly requiresToolCalls?: boolean;
  readonly localFallback?: {
    readonly openaiCompatUrl: string;
    readonly model: string;
    readonly openaiCompatApiKey?: Redacted.Redacted<string>;
  };
};
```

Mirror the OpenRouter branch in `RunAutoPrConfigOpenRouter`.

Extend `GeneratePrContentConfigDef` and `RunAutoPrConfigDef`:

```ts
openRouterApiKey: Config.option(Config.redacted("OPENROUTER_API_KEY")),
openRouterModel: Config.option(Config.string("AUTO_PR_OPENROUTER_MODEL")),
openRouterHttpReferer: Config.option(Config.string("AUTO_PR_OPENROUTER_HTTP_REFERER")),
openRouterTitle: Config.option(Config.string("AUTO_PR_OPENROUTER_TITLE")),
```

Implement:

```ts
function rejectHeaderControlChars(name: string, value: string): Effect.Effect<string, AutoPrConfigError> {
  return /[\r\n]/.test(value)
    ? Effect.fail(new AutoPrConfigError({ missing: [`${name} must not contain CR or LF`] }))
    : Effect.succeed(value);
}
```

Provider parsing:

```ts
function parseProvider(raw: string): Effect.Effect<AiProvider, AutoPrConfigError, never> {
  const trimmed = raw.trim().toLowerCase();
  return Match.value(trimmed).pipe(
    Match.when("local", () => Effect.succeed("local" as const)),
    Match.when("openrouter", () => Effect.succeed("openrouter" as const)),
    Match.when("github-models", () =>
      Effect.fail(
        new AutoPrConfigError({
          missing: [
            "Invalid AUTO_PR_AI_PROVIDER: github-models. GitHub Models was retired on 2026-07-30; use openrouter or local.",
          ],
        }),
      ),
    ),
    Match.orElse(() =>
      Effect.fail(
        new AutoPrConfigError({
          missing: [`Invalid AUTO_PR_AI_PROVIDER: ${raw}. Must be local or openrouter`],
        }),
      ),
    ),
  );
}
```

For `openrouter`:

- require `OPENROUTER_API_KEY`;
- parse `AUTO_PR_ROUTING_DECISION_JSON`;
- use `routingDecision.selectedModel` as the resolved `model`;
- if `AUTO_PR_OPENROUTER_MODEL` is present, trim and validate it, then keep it on config for diagnostics;
- set `openRouterTitle` to `DEFAULT_OPENROUTER_TITLE` when unset or blank;
- copy token budget, tool-round limit, and tool-response char budget from routing decision;
- preserve optional local fallback resolution.

Continue with client construction:

- [ ] **Step 5: Update the provider-layer type and OpenRouter client**

In `src/auto-pr/live/ai-provider.ts`:

```ts
export type AiProviderConfigOpenRouter = {
  readonly provider: "openrouter";
  readonly model: string;
  readonly apiKey: Redacted.Redacted<string>;
  readonly httpReferer?: string;
  readonly title?: string;
};

export type AiProviderConfig = AiProviderConfigLocal | AiProviderConfigOpenRouter;
```

Use the existing `OpenAiClient.Options.transformClient` API:

```ts
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

function addOpenRouterHeaders(input: {
  readonly httpReferer?: string;
  readonly title?: string;
}): (client: HttpClient.HttpClient) => HttpClient.HttpClient {
  return (client) =>
    HttpClient.mapRequest(client, (request) => {
      const withTitle = HttpClientRequest.setHeader(
        request,
        "X-OpenRouter-Title",
        input.title ?? DEFAULT_OPENROUTER_TITLE,
      );
      return input.httpReferer === undefined
        ? withTitle
        : HttpClientRequest.setHeader(withTitle, "HTTP-Referer", input.httpReferer);
    });
}
```

Construct OpenRouter with:

```ts
{
  apiUrl: OPENROUTER_API_URL,
  apiKey: openRouter.apiKey,
  transformClient: addOpenRouterHeaders({
    httpReferer: openRouter.httpReferer,
    title: openRouter.title,
  }),
}
```

Keep `normalizeOpenAiChatCompletionsFetch` provider-neutral; update comments to say it normalizes OpenAI-compatible tool-call history, not GitHub-specific behavior.

- [ ] **Step 6: Update `ai-provider-config.ts` and run-auto-pr mapping**

Map OpenRouter config to:

```ts
{
  provider: "openrouter",
  model: openRouter.model,
  apiKey: openRouter.openRouterApiKey,
  ...(openRouter.openRouterHttpReferer !== undefined ? { httpReferer: openRouter.openRouterHttpReferer } : {}),
  title: openRouter.openRouterTitle,
}
```

Update `test/workflow/run-auto-pr.test.ts` so the run pipeline maps `openrouter` into generate-content service config with the OpenRouter key and route-derived model.

- [ ] **Step 7: Run focused tests and commit**

```bash
bun test test/auto-pr/config.test.ts test/auto-pr/ai-provider-config.test.ts test/auto-pr/ai-provider.test.ts test/workflow/run-auto-pr.test.ts
git add src/auto-pr/config.ts src/auto-pr/ai-provider-config.ts src/auto-pr/live/ai-provider.ts src/auto-pr/index.ts test/auto-pr/config.test.ts test/auto-pr/ai-provider-config.test.ts test/auto-pr/ai-provider.test.ts test/workflow/run-auto-pr.test.ts
git commit -m "feat: wire OpenRouter provider config"
```

Expected: focused config/provider tests pass. Tests that still import GitHub catalog or fallback files may fail until Tasks 4 and 5.

---

## Task 4: Replace the routing-context command outputs with OpenRouter outputs

**Files:**

- Modify: `src/workflow/auto-pr-build-model-routing-context.ts`
- Modify: `.github/actions/auto-pr-run-command/action.yml`
- Modify: `test/scripts/auto-pr-model-routing.test.ts`
- Modify: `test/scripts/auto-pr-workflow.test.ts`
- Add if missing: `test/core/routing-artifacts.test.ts`

### Steps

- [ ] **Step 1: Write failing routing-command tests**

Update command tests to assert the OpenRouter output names:

```ts
expect(output).toContain("selected_model=openai/gpt-oss-20b:free");
expect(output).toContain("provider=openrouter");
expect(output).toContain("cloud_model_envelope_source=catalog");
expect(output).toContain("openrouter_model_context_length=131072");
expect(output).not.toContain("github_models_plan_class");
expect(output).not.toContain("github_models_rate_limit_tier");
```

Add a test where `AUTO_PR_AI_PROVIDER=github-models` exits with:

```text
Invalid AUTO_PR_AI_PROVIDER: github-models. GitHub Models was retired on 2026-07-30; use openrouter or local.
```

Add a test where catalog fetch returns no usable models, no configured model is set, and the routing
decision JSON still contains:

```json
{
  "provider": "openrouter",
  "selectedModel": "openai/gpt-oss-20b:free",
  "requiresToolCalls": true,
  "selectionMode": "static-fallback"
}
```

Add a second catalog-outage test where `AUTO_PR_OPENROUTER_MODEL=openrouter/free` or
`AUTO_PR_OPENROUTER_MODEL=openai/gpt-oss-20b:free` is set and the routing decision preserves that
configured model with `selectionMode: "configured"` instead of silently reverting to the static
default.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
bun test test/scripts/auto-pr-model-routing.test.ts test/scripts/auto-pr-workflow.test.ts
```

Expected: fail on old GitHub output names and provider parsing.

- [ ] **Step 3: Replace GitHub catalog usage in the routing command**

In `src/workflow/auto-pr-build-model-routing-context.ts`:

- import `OpenRouterModelsRepository` instead of `GithubModelsCatalogRepository`;
- parse provider as `local | openrouter`;
- remove GitHub plan-class detection and Copilot-plan detection from the active command path;
- read optional `AUTO_PR_OPENROUTER_MODEL`;
- for `openrouter`, fetch models through `OpenRouterModelsRepository.fetchModels(openRouterApiKey)`;
- call `pickOpenRouterModelCatalogEntry` and `buildOpenRouterRequestEnvelope`;
- preserve a statically valid configured model if the catalog is unavailable or unusable;
- emit `RoutingDecisionSchema` with provider `openrouter`, selected model, tool requirement, budget, band, and selection mode;
- emit routing context with provider `openrouter`;
- emit `cloud_model_envelope_source` and `openrouter_model_context_length`.

Keep local routing behavior unchanged.

- [ ] **Step 4: Update action metadata**

In `.github/actions/auto-pr-run-command/action.yml`, replace GitHub-specific output descriptions:

```yaml
cloud_model_envelope_source:
  description: Source used for cloud model token envelope selection.
openrouter_model_context_length:
  description: Context length of the selected OpenRouter model, when available.
```

Remove `github_models_plan_class`, `github_models_rate_limit_tier`, and `github_models_envelope_source`.

- [ ] **Step 5: Update routing artifact tests**

Ensure schema decode rejects `provider: "github-models"` and accepts `provider: "openrouter"`:

```ts
const decoded = Schema.decodeUnknownResult(RoutingDecisionSchema)({
  provider: "openrouter",
  selectedModel: "openai/gpt-oss-20b:free",
  requiresToolCalls: true,
  tokenBudget: 9000,
});

expect(Result.isSuccess(decoded)).toBe(true);
```

- [ ] **Step 6: Run focused tests and commit**

```bash
bun test test/scripts/auto-pr-model-routing.test.ts test/scripts/auto-pr-workflow.test.ts test/core/routing-artifacts.test.ts
git add src/workflow/auto-pr-build-model-routing-context.ts .github/actions/auto-pr-run-command/action.yml test/scripts/auto-pr-model-routing.test.ts test/scripts/auto-pr-workflow.test.ts test/core/routing-artifacts.test.ts
git commit -m "feat: route cloud generation through OpenRouter"
```

Expected: routing command and workflow-output tests pass.

---

## Task 5: Replace generate-content fallback orchestration

**Files:**

- Add: `src/core/openrouter-fallback-policy.ts`
- Add: `test/core/openrouter-fallback-policy.test.ts`
- Modify: `src/workflow/auto-pr-generate-content.ts`
- Modify: `test/workflow/generate-pr-content.test.ts`
- Modify: `test/workflow/generate-pr-content.tool-roundtrip.repro.test.ts`
- Modify: `test/workflow/run-auto-pr.test.ts`
- Delete later, after no imports remain: `src/core/github-model-fallback-policy.ts`

### Steps

- [ ] **Step 1: Write failing fallback-policy tests**

Add tests that encode OpenRouter documented error behavior:

```ts
test("classifyOpenRouterFailure treats auth and payment errors as permanent", () => {
  expect(classifyOpenRouterFailure(makeAiError(401, "invalid credentials"))).toEqual({
    kind: "permanent",
    reason: "authentication",
  });
  expect(classifyOpenRouterFailure(makeAiError(402, "insufficient credits"))).toEqual({
    kind: "permanent",
    reason: "payment-required",
  });
  expect(classifyOpenRouterFailure(makeAiError(403, "forbidden"))).toEqual({
    kind: "permanent",
    reason: "authorization",
  });
});

test("classifyOpenRouterFailure treats rate limits and provider availability as retryable", () => {
  expect(classifyOpenRouterFailure(makeAiError(429, "rate limit exceeded"))).toEqual({
    kind: "retryable",
    reason: "rate-limit",
  });
  expect(classifyOpenRouterFailure(makeAiError(503, "no provider available"))).toEqual({
    kind: "retryable",
    reason: "provider-unavailable",
  });
});
```

Add attempt-plan tests:

- when tools are required: selected OpenRouter model with tools, different free tool fallback with
  tools, optional local fallback with tools, then primitive commit-derived fallback;
- when tools are required: no OpenRouter or local no-tools AI attempt appears anywhere in the plan;
- when tools are not required: selected OpenRouter model without tools, different free text fallback
  without tools, optional local fallback without tools, then primitive commit-derived fallback;
- primitive commit-derived fallback remains last for transient cloud failures.

Continue with focused failure checks:

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
bun test test/core/openrouter-fallback-policy.test.ts test/workflow/generate-pr-content.test.ts
```

Expected: fail because the OpenRouter fallback module and generate config branch do not exist.

- [ ] **Step 3: Implement OpenRouter fallback policy**

Create provider-specific names:

```ts
export type OpenRouterFailureClassification =
  | { readonly kind: "permanent"; readonly reason: "authentication" | "authorization" | "payment-required" | "invalid-request" }
  | { readonly kind: "retryable"; readonly reason: "rate-limit" | "timeout" | "provider-overloaded" | "provider-unavailable" | "network" }
  | { readonly kind: "unknown-retryable"; readonly reason: "unknown" };

export function classifyOpenRouterFailure(error: unknown): OpenRouterFailureClassification;
export function shouldRetryOpenRouterAttempt(error: unknown): boolean;
```

Classification rules:

- `401` -> permanent authentication;
- `402` -> permanent payment-required;
- `403` -> permanent authorization or guardrail;
- `400` -> permanent invalid-request;
- `408`, `429`, `502`, `503`, `5xx`, network/timeout -> retryable;
- `error.metadata.error_type` values `rate_limit_exceeded`, `provider_overloaded`, and `provider_unavailable` -> retryable;
- `error.metadata.error_type` values `authentication`, `permission_denied`, `payment_required`, `invalid_request`, and `context_length_exceeded` -> permanent;
- unknown status-less AI transport errors remain retryable through the attempt plan.

Continue with generation orchestration:

- [ ] **Step 4: Update `auto-pr-generate-content.ts` provider branches**

Replace `github-models` branches with `openrouter`:

- `RunGeneratePrContentConfig` has an OpenRouter variant with `openRouterApiKey`, optional attribution, `requiresToolCalls`, budgets, and optional local fallback;
- `buildAiProviderConfig` returns `AiProviderConfigOpenRouter`;
- provider display names become `openrouter` and `local`;
- troubleshooting hints say `Check OPENROUTER_API_KEY, key credit limits, and OpenRouter free-model rate limits.`;
- attempt construction uses `buildOpenRouterModelAttemptPlan`;
- attempt construction must not downgrade a tool-required route to a no-tools AI request. If
  tool-capable OpenRouter and local attempts are exhausted, move to the deterministic primitive
  fallback rather than accepting a text-only AI response;
- catalog fallback calls `OpenRouterModelsRepository.fetchModels(openRouterApiKey)`;
- local fallback behavior remains the same;
- primitive commit-derived fallback remains the last fallback for transient cloud failures.

Keep `LanguageModel.generateText` plus JSON parse plus Schema decode. Do not introduce `generateObject`.

- [ ] **Step 5: Update tool-roundtrip regression tests**

Rename comments and provider setup from GitHub Models to OpenRouter while keeping the underlying OpenAI-compatible tool-call regression:

```ts
provider: "openrouter",
model: "openai/gpt-oss-20b:free",
openRouterApiKey: Redacted.make("sk-or-test", { label: "OPENROUTER_API_KEY" }),
requiresToolCalls: true,
```

Keep the assertion that adjacent assistant tool-call messages are coalesced before the HTTP boundary.

- [ ] **Step 6: Run focused tests and commit**

```bash
bun test test/core/openrouter-fallback-policy.test.ts test/workflow/generate-pr-content.test.ts test/workflow/generate-pr-content.tool-roundtrip.repro.test.ts test/workflow/run-auto-pr.test.ts
git add src/core/openrouter-fallback-policy.ts src/workflow/auto-pr-generate-content.ts test/core/openrouter-fallback-policy.test.ts test/workflow/generate-pr-content.test.ts test/workflow/generate-pr-content.tool-roundtrip.repro.test.ts test/workflow/run-auto-pr.test.ts
git commit -m "feat: use OpenRouter fallback orchestration"
```

Expected: generate-content tests pass with OpenRouter provider branches.

---

## Task 6: Update workflows, CI, and cloud integration tests

**Files:**

- Modify: `.github/workflows/auto-pr.yml`
- Modify: `.github/workflows/auto-pr-generate-reusable.yml`
- Modify: `.github/workflows/integration.yml`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/actions/auto-pr-run-command/action.yml`
- Modify: `.github/actions/auto-pr-run-command/auto-pr-run-command.sh`
- Modify: `.github/actions/load-env-ci/action.yml`
- Modify: `.env.ci`
- Rename: `test/integration/ai-providers.github-models.integration.test.ts` -> `test/integration/ai-providers.openrouter.integration.test.ts`
- Modify: `test/integration/ai-providers.openrouter.integration.test.ts`
- Modify: `test/integration/helpers.ts`
- Modify: `test/scripts/auto-pr-workflow.test.ts`

### Steps

- [ ] **Step 1: Write failing workflow tests**

Update workflow tests:

```ts
test("generate reusable workflow defaults to openrouter without models permission", () => {
  const workflow = parseWorkflow(".github/workflows/auto-pr-generate-reusable.yml");
  expect(workflow.on.workflow_call.inputs.ai_provider.default).toBe("openrouter");
  expect(workflow.on.workflow_call.secrets.OPENROUTER_API_KEY.required).toBe(false);
  expect(workflow.jobs.generate.permissions.models).toBeUndefined();
  expect(stringify(workflow)).toContain("OPENROUTER_API_KEY");
  expect(stringify(workflow)).not.toContain("models: read");
});

test("stock auto-pr workflow limits parallel OpenRouter generation", () => {
  const workflow = parseWorkflow(".github/workflows/auto-pr.yml");
  expect(workflow.jobs.generate.strategy["max-parallel"]).toBe(2);
});
```

Add assertions that the OpenRouter env is present on both workflow steps:

```ts
const routingEnv =
  workflow.jobs.generate.steps.find((step) => step.name === "Build model routing context")?.env;
expect(routingEnv.OPENROUTER_API_KEY).toContain("secrets.OPENROUTER_API_KEY");
expect(routingEnv.AUTO_PR_OPENROUTER_MODEL).toBe("${{ inputs.ai_openrouter_model }}");

const generateEnv =
  workflow.jobs.generate.steps.find((step) => step.name === "Generate PR content")?.env;
expect(generateEnv.OPENROUTER_API_KEY).toContain("secrets.OPENROUTER_API_KEY");
expect(generateEnv.AUTO_PR_OPENROUTER_HTTP_REFERER).toBe("${{ inputs.ai_openrouter_http_referer }}");
expect(generateEnv.AUTO_PR_OPENROUTER_TITLE).toBe("${{ inputs.ai_openrouter_title }}");
```

Add secret-boundary assertions:

```ts
const keyedSteps = workflow.jobs.generate.steps.filter((step) =>
  JSON.stringify(step.env ?? {}).includes("OPENROUTER_API_KEY"),
);
expect(keyedSteps.map((step) => step.name)).toEqual([
  "Build model routing context",
  "Generate PR content",
]);

for (const step of keyedSteps) {
  expect(step.with.use_workspace).toContain("inputs.ai_provider == 'openrouter'");
  expect(step.with.use_workspace).toContain("'false'");
  expect(step.with.trusted_package_required).toContain("inputs.ai_provider == 'openrouter'");
  expect(step.with.auto_pr_pkg).toMatch(/github:knirski\/auto-pr#[0-9a-f]{40}/);
}
```

Add action tests or workflow-string assertions that `auto-pr-run-command.sh` fails closed when
`trusted_package_required=true` and either `USE_WORKSPACE=true` or `AUTO_PR_PKG` is not pinned to a
40-character SHA.

Update integration workflow tests to look for `integration-openrouter` and not `integration-github-models`. Also assert the workflow YAML does not contain `if:.*secrets.OPENROUTER_API_KEY`; GitHub does not support direct secret references in `if:` conditionals.

- [ ] **Step 2: Run workflow tests and confirm RED**

```bash
bun test test/scripts/auto-pr-workflow.test.ts
```

Expected: fail on old workflow defaults and permissions.

- [ ] **Step 3: Update the reusable generate workflow**

In `.github/workflows/auto-pr-generate-reusable.yml`:

- set `inputs.ai_provider.default` to `openrouter`;
- add `inputs.ai_openrouter_model`, `inputs.ai_openrouter_http_referer`, and `inputs.ai_openrouter_title`;
- add optional secret `OPENROUTER_API_KEY`;
- keep `GH_TOKEN` only for GitHub API reads such as existing PR title lookup;
- remove job-level `models: read`;
- for both OpenRouter-capable `auto-pr-run-command` steps, force trusted command execution whenever
  `inputs.ai_provider == 'openrouter'`:

```yaml
use_workspace: ${{ inputs.ai_provider == 'openrouter' && 'false' || steps.auto-pr-pkg.outputs.use_workspace }}
auto_pr_pkg: ${{ inputs.ai_provider == 'openrouter' && 'github:knirski/auto-pr#<same 40-char self-ref SHA>' || 'github:knirski/auto-pr' }}
trusted_package_required: ${{ inputs.ai_provider == 'openrouter' && 'true' || 'false' }}
```

Use the same 40-character SHA that pins the `knirski/auto-pr/.github/actions/*` self-references in
the workflow. When workflow/action pins are bumped, update this package ref in the same commit.

- pass this env to the `Build model routing context` step:

```yaml
AUTO_PR_AI_PROVIDER: ${{ inputs.ai_provider }}
OPENROUTER_API_KEY: ${{ inputs.ai_provider == 'openrouter' && secrets.OPENROUTER_API_KEY || '' }}
AUTO_PR_OPENROUTER_MODEL: ${{ inputs.ai_openrouter_model }}
```

- pass this env to the `Generate PR content` step:

```yaml
AUTO_PR_AI_PROVIDER: ${{ inputs.ai_provider }}
OPENROUTER_API_KEY: ${{ inputs.ai_provider == 'openrouter' && secrets.OPENROUTER_API_KEY || '' }}
AUTO_PR_OPENROUTER_MODEL: ${{ inputs.ai_openrouter_model }}
AUTO_PR_OPENROUTER_HTTP_REFERER: ${{ inputs.ai_openrouter_http_referer }}
AUTO_PR_OPENROUTER_TITLE: ${{ inputs.ai_openrouter_title }}
GH_TOKEN: ${{ secrets.GH_TOKEN || github.token }}
```

The routing step needs the key and configured model because it fetches the OpenRouter catalog and selects the free model before `generate-content` runs. The generate step needs the key, model, and attribution fields because it performs inference through OpenRouter.

No other step should receive `OPENROUTER_API_KEY`; specifically, dependency installation,
setup/runtime selection, local llama startup, artifact preparation, and arbitrary branch-controlled
shell commands must not see it.

In `.github/actions/auto-pr-run-command/action.yml`, add optional input:

```yaml
trusted_package_required:
  description: "true to fail unless package mode uses an immutable trusted auto-pr package ref"
  required: false
  default: "false"
```

In `.github/actions/auto-pr-run-command/auto-pr-run-command.sh`, before selecting the command:

```bash
TRUSTED_PACKAGE_REQUIRED="${TRUSTED_PACKAGE_REQUIRED:-false}"

if [ "$TRUSTED_PACKAGE_REQUIRED" = "true" ]; then
  if [ "$USE_WORKSPACE" != "false" ]; then
    echo "::error::Trusted package mode is required for secret-bearing OpenRouter steps"
    exit 1
  fi
  if ! printf '%s' "$AUTO_PR_PKG" | grep -Eq '^github:knirski/auto-pr#[0-9a-f]{40}$'; then
    echo "::error::AUTO_PR_PKG must be pinned to a 40-character SHA when trusted package mode is required"
    exit 1
  fi
fi
```

- [ ] **Step 4: Update the stock workflow**

In `.github/workflows/auto-pr.yml`:

- remove `models: read` from generate permissions;
- pass `secrets.OPENROUTER_API_KEY` into the reusable generate workflow;
- set `strategy.max-parallel: 2` on the matrix job that runs across `ai/**` branches;
- update comments that mention GitHub Models inference;
- update the file header's "NO secrets" wording to say no GitHub write/App secrets. The generate job now receives an optional OpenRouter inference secret when cloud generation is enabled.

Continue with CI cloud integration:

- [ ] **Step 5: Update CI cloud integration**

In `.github/workflows/integration.yml`:

- rename job `integration-github-models` to `integration-openrouter`;
- remove `models: read` from every integration job, including the local llama jobs;
- keep the real cloud integration out of required PR/push CI by preserving the `workflow_dispatch` or `schedule` event gate;
- do not reference `secrets.OPENROUTER_API_KEY` directly in `if:`. GitHub documents that secrets cannot be used directly in `if:` conditionals;
- project the secret into job or step env and skip the OpenRouter test step when the projected env value is blank;
- set env:

```yaml
OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
INTEGRATION_OPENROUTER_MODEL: ${{ env.INTEGRATION_OPENROUTER_MODEL }}
AUTO_PR_AI_PROVIDER: openrouter
```

In `.github/workflows/ci.yml`, remove `models: read` from the `check` and `integration` reusable-workflow callers. The OpenRouter real-cloud integration remains skipped for `workflow_call`, so no OpenRouter secret needs to be passed through required CI.

In `.github/actions/load-env-ci/action.yml`, rename the input description from GitHub Models-specific wording to cloud-only wording, or split it into `omit_llama_integration_env` with an OpenRouter description.

In `.env.ci`:

```dotenv
INTEGRATION_OPENROUTER_MODEL=openai/gpt-oss-20b:free
```

Do not add `OPENROUTER_API_KEY` to `.env.ci`.

- [ ] **Step 6: Update integration test names and helpers**

Rename the real cloud test:

```bash
git mv test/integration/ai-providers.github-models.integration.test.ts test/integration/ai-providers.openrouter.integration.test.ts
```

Update the test to skip without a key:

```ts
const openRouterApiKey = process.env.OPENROUTER_API_KEY;
const openRouterModel = process.env.INTEGRATION_OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL;

const maybeTest = openRouterApiKey === undefined || openRouterApiKey.trim() === "" ? test.skip : test;
```

Use provider config:

```ts
provider: "openrouter",
model: openRouterModel,
openRouterApiKey: Redacted.make(openRouterApiKey, { label: "OPENROUTER_API_KEY" }),
requiresToolCalls: true,
```

Update `test/integration/helpers.ts` to expose `layerOpenRouter` or provider-neutral helpers only if a helper is currently GitHub-named.

- [ ] **Step 7: Run focused workflow and integration tests, then commit**

```bash
bun test test/scripts/auto-pr-workflow.test.ts test/integration/ai-providers.openrouter.integration.test.ts
bun run act -- --dry-run check
git add .github/workflows/auto-pr.yml .github/workflows/auto-pr-generate-reusable.yml .github/workflows/integration.yml .github/workflows/ci.yml .github/actions/auto-pr-run-command/action.yml .github/actions/auto-pr-run-command/auto-pr-run-command.sh .github/actions/load-env-ci/action.yml .env.ci test/integration/ai-providers.openrouter.integration.test.ts test/integration/helpers.ts test/scripts/auto-pr-workflow.test.ts
git commit -m "feat(workflows): switch cloud generation to OpenRouter"
```

Expected: workflow tests pass; dry-run graph validation exits 0. The OpenRouter integration test is skipped locally unless `OPENROUTER_API_KEY` is set.

---

## Task 7: Remove retired GitHub Models code paths and update exports

**Files:**

- Delete: `src/auto-pr/interfaces/github-models-catalog-repository.ts`
- Delete: `src/auto-pr/live/github-models-catalog-repository.ts`
- Delete: `src/core/github-model-routing.ts`
- Delete: `src/core/github-model-fallback-policy.ts`
- Delete or rename: `test/auto-pr/github-models-catalog-repository.test.ts`
- Delete or rename: `test/core/github-model-routing.test.ts`
- Delete or rename: `test/core/github-model-fallback-policy.test.ts`
- Modify: `src/auto-pr/index.ts`
- Modify: `src/workflow/auto-pr-run-pipeline.ts`
- Modify: every remaining non-historical source/test import found by `rg`

### Steps

- [ ] **Step 1: Find active retired-provider references**

Run:

```bash
rg -n "github-models|GithubModels|GitHub Models|githubModels|models.github.ai|github_models" src test .github .env.ci
```

Expected before this task: only references targeted for removal or renamed tests remain.

- [ ] **Step 2: Remove old files after imports are gone**

Use `git rm`:

```bash
git rm src/auto-pr/interfaces/github-models-catalog-repository.ts
git rm src/auto-pr/live/github-models-catalog-repository.ts
git rm src/core/github-model-routing.ts
git rm src/core/github-model-fallback-policy.ts
git rm test/auto-pr/github-models-catalog-repository.test.ts
git rm test/core/github-model-routing.test.ts
git rm test/core/github-model-fallback-policy.test.ts
```

If any test content was moved into OpenRouter-named tests in prior tasks, confirm those files are already covered before deleting.

- [ ] **Step 3: Update active exports and run pipeline wiring**

In `src/auto-pr/index.ts`, remove all GitHub catalog exports. Export the OpenRouter core helpers that downstream users need:

```ts
export {
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_OPENROUTER_TITLE,
  OPENROUTER_API_URL,
  OPENROUTER_FREE_MODEL_PREFERENCES,
  buildOpenRouterRequestEnvelope,
  parseOpenRouterModelCatalog,
  pickOpenRouterModelCatalogEntry,
  validateOpenRouterModelId,
} from "#core/openrouter-routing.js";
```

In `src/workflow/auto-pr-run-pipeline.ts`, replace provider literals:

```ts
{ provider: "openrouter" }
```

Preserve local provider branches.

- [ ] **Step 4: Assert no active GitHub Models strings remain**

Run:

```bash
rg -n "github-models|GithubModels|githubModels|models.github.ai|github_models" src test .github .env.ci
```

Expected: no output.

Run:

```bash
rg -n "GitHub Models" docs/adr docs/superpowers/specs docs/superpowers/plans
```

Expected: historical references remain in ADRs/specs/plans only.

- [ ] **Step 5: Run focused source tests and commit**

```bash
bun test test/auto-pr test/core test/workflow
git add -A
git commit -m "refactor: remove retired GitHub Models code"
```

Expected: active source and workflow tests pass without importing retired GitHub Models modules.

---

## Task 8: Update adopter documentation and security guidance

**Files:**

- Modify: `AGENTS.md`
- Modify: `.cursor/rules/*.mdc` when provider-policy text appears there
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/CI.md`
- Modify: `docs/INTEGRATION.md`
- Modify: `docs/TROUBLESHOOTING.md`
- Modify: `docs/WORKFLOW_SECURITY.md`
- Modify: `docs/PR_TEMPLATE.md` if provider wording appears there
- Modify: `docs/adr/0007-ai-abstraction-layer.md`
- Modify: `docs/adr/0009-ollama-to-openai-compat-migration.md`
- Modify: `docs/adr/0013-transient-vs-permanent-ai-errors.md`
- Modify: `docs/adr/0016-immutable-privileged-workflow-executor.md`
- Modify: website copied-doc tests only if documentation tests require path/text updates

### Steps

- [ ] **Step 1: Write or update doc tests first**

If existing tests assert docs content or website copied docs, update them before changing docs. Add a lightweight test if none exists for integration docs:

```ts
test("integration docs mention OpenRouter secret and not models read", async () => {
  const docs = await Bun.file("docs/INTEGRATION.md").text();
  expect(docs).toContain("OPENROUTER_API_KEY");
  expect(docs).toContain("openrouter");
  expect(docs).not.toContain("models: read");
});
```

If the project does not currently test doc strings, keep this check as a manual verification command in Step 5 instead of adding a brittle test.

- [ ] **Step 2: Update operational docs**

Document these exact migration points:

- GitHub Models was retired on 2026-07-30.
- OpenRouter is the default cloud provider in stock workflows.
- Users must create an OpenRouter key and store it as `OPENROUTER_API_KEY`.
- Free model IDs must be `vendor/model:free`, with `openrouter/free` allowed only as an explicit router choice.
- The default model is `openai/gpt-oss-20b:free`.
- `models: read` is no longer required for generate jobs.
- `GH_TOKEN` remains for PR lookup/create operations, not inference.
- `429` means OpenRouter rate limit or upstream provider limit; retry/backoff and free-model quota are documented by OpenRouter.
- `402` means credit or key limit exhaustion; advise checking `GET /api/v1/key` or OpenRouter dashboard.
- Recommend a dedicated low-limit OpenRouter key for auto-pr.
- The generate workflow may check out untrusted branch code, but OpenRouter-keyed commands must run
  trusted pinned auto-pr code and treat the checkout as data only.

Continue with architecture docs:

- [ ] **Step 3: Update architecture docs**

In `docs/ARCHITECTURE.md`, update provider flow:

```text
auto-pr-build-model-routing-context -> OpenRouter models catalog -> routing decision JSON
auto-pr-generate-content -> @effect/ai-openai-compat -> https://openrouter.ai/api/v1/chat/completions
```

Keep local llama architecture unchanged.

- [ ] **Step 4: Update ADRs with current-state notes**

Do not rewrite history in old ADRs. Add short dated notes where active behavior changed:

```markdown
> 2026-08-04 update: GitHub Models was retired on 2026-07-30. The active cloud provider is now OpenRouter; historical references to `github-models` in this ADR describe the original decision state.
```

For ADR 0016, update the generate-phase statement from `contents: read` plus `models: read` to
`contents: read` plus the externally provided OpenRouter key when cloud generation is enabled.
Preserve the warning that generate receives no GitHub write token, and add the new requirement that
OpenRouter-keyed steps execute trusted pinned auto-pr code rather than branch-controlled workspace
scripts.

- [ ] **Step 5: Run docs checks and targeted search**

```bash
bun x rumdl check AGENTS.md docs .github/actions/auto-pr-run-command/action.yml
scripts/nix-run-if-missing.sh typos
rg -n "github-models|GithubModels|githubModels|models.github.ai|github_models|models: read" AGENTS.md .cursor docs README.md .github
```

Expected:

- rumdl exits 0;
- typos exits 0;
- search output contains only historical design/plan/ADR references and explanatory migration text;
- no active workflow/action/provider docs describe GitHub Models as supported.

Continue with the docs commit:

- [ ] **Step 6: Commit documentation updates**

```bash
git add AGENTS.md .cursor docs README.md .github/actions/auto-pr-run-command/action.yml
git commit -m "docs: document OpenRouter migration"
```

Expected: docs are internally consistent and adopter-facing docs use `openrouter`/`OPENROUTER_API_KEY`.

---

## Task 9: Full verification, workflow graph validation, and final cleanup

**Files:**

- No planned source changes.
- Restore generated `dist/` before final commit if checks modify it.

### Steps

- [ ] **Step 1: Run full check**

```bash
bun run check
```

Expected: exit 0 with lint, typecheck, tests, docs, actionlint, shellcheck, and generated docs checks passing.

- [ ] **Step 2: Run workflow graph validation**

```bash
bun run act -- --dry-run check
```

Expected: exit 0 and the workflow graph resolves without `models: read` requirements for OpenRouter generation.

If Docker is available and the branch changed workflow/action behavior beyond env wiring, also run:

```bash
bun run act -- check-workflows
```

Expected: exit 0. If Docker is unavailable, record the exact Docker/act error in the PR body and rely on `bun run check` plus dry-run graph validation.

- [ ] **Step 3: Confirm no active retired provider remains**

```bash
rg -n "github-models|GithubModels|githubModels|models.github.ai|github_models" src test .github .env.ci
```

Expected: no output.

```bash
rg -n "models: read" .github/workflows .github/actions
```

Expected: no output unless a future unrelated workflow still needs the permission and documents why.

- [ ] **Step 4: Inspect changed files**

```bash
git diff --stat
git status --short
```

Expected:

- OpenRouter source, tests, workflows, and docs are changed;
- GitHub Models source/tests are deleted or renamed;
- no generated `dist/` changes are staged.

If `dist/` is dirty:

```bash
git restore dist
```

- [ ] **Step 5: Commit final cleanup if needed**

Only run this when Step 4 shows cleanup changes not already committed:

```bash
git add -A
git commit -m "chore: finalize OpenRouter migration"
```

- [ ] **Step 6: Push and open the implementation PR**

```bash
git push -u origin ai/openrouter-migration-implementation
gh pr create \
  --base main \
  --head ai/openrouter-migration-implementation \
  --title "feat: migrate cloud AI generation to OpenRouter" \
  --body-file /tmp/auto-pr-openrouter-implementation-pr-body.md
```

The PR body must include:

- migration reason with the GitHub retirement date;
- OpenRouter docs consulted;
- the default model and free-model policy;
- verification commands and exact results;
- whether real OpenRouter integration ran or skipped due to missing `OPENROUTER_API_KEY`;
- migration steps for adopters.

Expected: PR is open against `main`. If the design PR has not merged when implementation starts, base the implementation branch on `ai/openrouter-migration` and note that the PR is stacked.
