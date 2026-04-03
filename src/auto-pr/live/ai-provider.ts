/**
 * AI provider layer factory. Builds Layer<LanguageModel> from config.
 * Providers: `local` (any local LLM via OpenAI-compatible HTTP — llama.cpp today), `github-models`.
 *
 * Both use `@effect/ai-openai-compat` (`OpenAiClient.layer` + `OpenAiLanguageModel.model`) + `FetchHttpClient`.
 * Generate-content uses `LanguageModel.generateText` + JSON parse (not `generateObject` / `json_schema`); see `auto-pr-generate-content.ts`.
 *
 * ADR: docs/adr/0007-ai-abstraction-layer.md, docs/adr/0009-ollama-to-openai-compat-migration.md
 */

import * as OpenAiClient from "@effect/ai-openai-compat/OpenAiClient";
import * as OpenAiLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel";
import type { Redacted } from "effect";
import { Effect, Layer, Match, Redacted as RedactedValue } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import type { AiProvider } from "#auto-pr/config.js";
import { DEFAULT_OPENAI_COMPAT_URL } from "#auto-pr/config.js";
import { AutoPrConfigError } from "#core/errors.js";

const GITHUB_MODELS_INFERENCE_URL = "https://models.github.ai/inference";

/** Config for AI provider layer (provider, model, and provider-specific fields). */
export interface AiProviderConfig {
	readonly provider: AiProvider;
	readonly model: string;
	/** Required when `provider` is `github-models`. */
	readonly ghToken?: Redacted.Redacted<string>;
	/** Base URL when `provider` is `local` (OpenAI-compatible `/v1/...`). Defaults in config/env. */
	readonly openaiCompatUrl?: string;
	/** Optional API key when `provider` is `local`. */
	readonly openaiCompatApiKey?: Redacted.Redacted<string>;
}

function openAiLanguageModelStack(
	clientOptions: OpenAiClient.Options,
	modelId: string,
	fetchOverrideLayer: Layer.Layer<never>,
): Layer.Layer<LanguageModel.LanguageModel, never> {
	const clientLayer = OpenAiClient.layer(clientOptions).pipe(Layer.provide(FetchHttpClient.layer));
	const modelLayer = OpenAiLanguageModel.model(modelId);
	return Layer.mergeAll(
		fetchOverrideLayer,
		modelLayer.pipe(Layer.provide(clientLayer)),
	) as Layer.Layer<LanguageModel.LanguageModel, never>;
}

/**
 * Build Layer<LanguageModel> from provider config.
 * Supports `local` and `github-models`.
 *
 * Pass `options.fetch` in tests to mock `POST …/chat/completions` (OpenAI-compatible JSON).
 */
export function aiProviderLayerFromConfig(
	config: AiProviderConfig,
	options?: { fetch?: typeof fetch },
): Layer.Layer<LanguageModel.LanguageModel, AutoPrConfigError> {
	const fetchOverrideLayer =
		options?.fetch !== undefined
			? Layer.succeed(FetchHttpClient.Fetch, options.fetch)
			: Layer.empty;

	return Match.value(config.provider).pipe(
		Match.when("local", () => {
			const apiUrl = config.openaiCompatUrl ?? DEFAULT_OPENAI_COMPAT_URL;
			const apiKey = config.openaiCompatApiKey;
			const hasKey = apiKey !== undefined && RedactedValue.value(apiKey).trim() !== "";
			const clientOptions: OpenAiClient.Options = {
				apiUrl,
				...(hasKey ? { apiKey } : {}),
			};
			return openAiLanguageModelStack(clientOptions, config.model, fetchOverrideLayer);
		}),
		Match.when("github-models", () => {
			if (!config.ghToken || RedactedValue.value(config.ghToken).trim() === "" || !config.model) {
				return Layer.effect(
					LanguageModel.LanguageModel,
					Effect.fail(
						new AutoPrConfigError({
							missing: [
								"GH_TOKEN and model (AUTO_PR_AI_OPENAI_COMPAT_MODEL) required for github-models",
							],
						}),
					),
				);
			}
			const clientOptions: OpenAiClient.Options = {
				apiUrl: GITHUB_MODELS_INFERENCE_URL,
				apiKey: config.ghToken,
			};
			return openAiLanguageModelStack(clientOptions, config.model, fetchOverrideLayer);
		}),
		Match.exhaustive,
	) as Layer.Layer<LanguageModel.LanguageModel, AutoPrConfigError>;
}
