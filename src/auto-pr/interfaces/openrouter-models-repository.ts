import type { Effect } from "effect";
import type { OpenRouterModelCatalogEntry } from "#core/openrouter-routing.js";

/**
 * Read-only access to the OpenRouter model catalog.
 *
 * Authentication lives in the `OpenRouterClient` layer; the repository is
 * key-less so catalog discovery can degrade to static free-model fallback.
 */
export interface OpenRouterModelsRepositoryService {
  readonly fetchModels: () => Effect.Effect<readonly OpenRouterModelCatalogEntry[], never, never>;
}
