import type { Effect, Redacted } from "effect";
import type { GithubModelCatalogEntry } from "#core/github-model-routing.js";

export interface GithubModelsCatalogRepositoryService {
  readonly fetchCatalog: (
    token: Redacted.Redacted<string>,
  ) => Effect.Effect<readonly GithubModelCatalogEntry[], never, never>;
}
