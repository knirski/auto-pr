import { Context, Effect, Layer, Redacted } from "effect";
import type { GithubModelsCatalogRepositoryService } from "#auto-pr/interfaces/github-models-catalog-repository.js";
import {
	type GithubModelCatalogEntry,
	parseGithubModelsRateLimitTier,
} from "#core/github-model-routing.js";

const GITHUB_MODELS_CATALOG_FETCH_TIMEOUT = "5 seconds";

function parseGithubCatalogEntries(raw: unknown): readonly GithubModelCatalogEntry[] {
	if (!Array.isArray(raw)) return [];
	const entries: GithubModelCatalogEntry[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		const candidate = item as Record<string, unknown>;
		const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
		if (id === "") continue;
		const capabilities = Array.isArray(candidate.capabilities)
			? candidate.capabilities.filter((x): x is string => typeof x === "string")
			: [];
		const supportedInputModalities = Array.isArray(candidate.supported_input_modalities)
			? candidate.supported_input_modalities.filter((x): x is string => typeof x === "string")
			: [];
		const supportedOutputModalities = Array.isArray(candidate.supported_output_modalities)
			? candidate.supported_output_modalities.filter((x): x is string => typeof x === "string")
			: [];
		const limits =
			typeof candidate.limits === "object" && candidate.limits !== null
				? (candidate.limits as Record<string, unknown>)
				: undefined;
		const maxInputTokens =
			typeof limits?.max_input_tokens === "number" && Number.isFinite(limits.max_input_tokens)
				? limits.max_input_tokens
				: 8_000;
		const maxOutputTokens =
			typeof limits?.max_output_tokens === "number" && Number.isFinite(limits.max_output_tokens)
				? limits.max_output_tokens
				: 2_000;
		entries.push({
			id,
			name: typeof candidate.name === "string" ? candidate.name : id,
			capabilities,
			supportedInputModalities,
			supportedOutputModalities,
			maxInputTokens,
			maxOutputTokens,
			rateLimitTier: parseGithubModelsRateLimitTier(
				typeof candidate.rate_limit_tier === "string" ? candidate.rate_limit_tier : undefined,
			),
		});
	}
	return entries;
}

export const GithubModelsCatalogRepository = Context.Service<GithubModelsCatalogRepositoryService>(
	"GithubModelsCatalogRepository",
);

export type GithubModelsCatalogRepositoryLiveOptions = {
	readonly fetchImpl?: typeof fetch;
};

export const makeGithubModelsCatalogRepositoryLive = (
	options: GithubModelsCatalogRepositoryLiveOptions = {},
) =>
	Layer.succeed(GithubModelsCatalogRepository, {
		fetchCatalog: (token) =>
			Effect.tryPromise({
				try: async (signal) => {
					const response = await (options.fetchImpl ?? fetch)(
						"https://models.github.ai/catalog/models",
						{
							method: "GET",
							signal,
							headers: {
								accept: "application/json",
								authorization: `Bearer ${Redacted.value(token)}`,
							},
						},
					);
					if (!response.ok) return [];
					return parseGithubCatalogEntries((await response.json()) as unknown);
				},
				catch: () => [],
			}).pipe(
				Effect.timeout(GITHUB_MODELS_CATALOG_FETCH_TIMEOUT),
				Effect.catch(() => Effect.succeed([])),
			),
	});

export const GithubModelsCatalogRepositoryLive = makeGithubModelsCatalogRepositoryLive();
