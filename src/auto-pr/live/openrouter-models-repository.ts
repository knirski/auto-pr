/**
 * Live OpenRouter model-catalog repository.
 *
 * Uses the generated `@effect/ai-openrouter` client (`client.getModels`) so the
 * request/response wire shape stays owned by the provider module. Any failure
 * (non-2xx, schema decode, network, timeout) degrades to an empty catalog; the
 * pure routing policy then falls back to a static free model.
 */

import * as OpenRouterClient from "@effect/ai-openrouter/OpenRouterClient";
import { Context, Effect, Layer, type Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import type { OpenRouterModelsRepositoryService } from "#auto-pr/interfaces/openrouter-models-repository.js";
import { parseOpenRouterModelCatalog } from "#core/openrouter-routing.js";

const OPENROUTER_MODELS_FETCH_TIMEOUT = "5 seconds";
const OPENROUTER_MODELS_FETCH_LIMIT = 1000;

export const OpenRouterModelsRepository = Context.Service<OpenRouterModelsRepositoryService>(
  "OpenRouterModelsRepository",
);

/** Requires an `OpenRouterClient` (which owns the API key and site headers). */
export const OpenRouterModelsRepositoryLive: Layer.Layer<
  OpenRouterModelsRepositoryService,
  never,
  OpenRouterClient.OpenRouterClient
> = Layer.effect(
  OpenRouterModelsRepository,
  Effect.gen(function* () {
    const client = yield* OpenRouterClient.OpenRouterClient;
    return OpenRouterModelsRepository.of({
      fetchModels: () =>
        client.client.getModels({ params: { limit: OPENROUTER_MODELS_FETCH_LIMIT } }).pipe(
          Effect.map(parseOpenRouterModelCatalog),
          Effect.timeout(OPENROUTER_MODELS_FETCH_TIMEOUT),
          Effect.catch(() => Effect.succeed([])),
        ),
    });
  }),
);

export type OpenRouterModelsRepositoryLiveOptions = {
  readonly apiKey?: Redacted.Redacted<string>;
  readonly fetchImpl?: typeof fetch;
};

/**
 * Self-contained live layer for tests: builds an `OpenRouterClient` from
 * explicit options and an optional mock `fetch`.
 */
export const makeOpenRouterModelsRepositoryLive = (
  options: OpenRouterModelsRepositoryLiveOptions = {},
): Layer.Layer<OpenRouterModelsRepositoryService, never, never> => {
  const httpLayer =
    options.fetchImpl === undefined
      ? FetchHttpClient.layer
      : FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, options.fetchImpl)),
        );
  const clientLayer = OpenRouterClient.layer(
    options.apiKey === undefined ? {} : { apiKey: options.apiKey },
  ).pipe(Layer.provide(httpLayer));
  return OpenRouterModelsRepositoryLive.pipe(Layer.provide(clientLayer));
};
