/**
 * AI provider layer factory. Builds Layer<LanguageModel> from config.
 * Dispatches by AUTO_PR_AI_PROVIDER: ollama, github-models (OpenAI-compat), openai-compat (deferred).
 *
 * Spec: docs/superpowers/specs/2026-03-22-ai-abstraction-layer-design.md
 * ADR: docs/adr/0007-ai-abstraction-layer.md
 */

import * as OpenAiClient from "@effect/ai-openai-compat/OpenAiClient";
import * as OpenAiLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel";
import type { Redacted } from "effect";
import { Effect, Layer, Match } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import type { AiProvider } from "#auto-pr/config.js";
import { AutoPrConfigError } from "#auto-pr/errors.js";
import { ollamaLanguageModelLayer } from "#auto-pr/live/ollama-language-model.js";

const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
const GITHUB_MODELS_INFERENCE_URL = "https://models.github.ai/inference";

const notImplemented = (provider: string) =>
	Layer.effect(
		LanguageModel.LanguageModel,
		Effect.fail(
			new AutoPrConfigError({
				missing: [`AUTO_PR_AI_PROVIDER=${provider} not yet implemented. Use ollama.`],
			}),
		),
	);

/** Config for AI provider layer (provider, model, and provider-specific fields). */
export interface AiProviderConfig {
	readonly provider: AiProvider;
	readonly model: string;
	/** Required when `provider` is `github-models`. */
	readonly ghToken?: Redacted.Redacted<string>;
}

/**
 * Build Layer<LanguageModel> from provider config.
 * Ollama and github-models are supported; openai-compat is not yet implemented.
 */
export function aiProviderLayerFromConfig(
	config: AiProviderConfig,
	options?: { fetch?: typeof fetch },
): Layer.Layer<LanguageModel.LanguageModel, AutoPrConfigError> {
	return Match.value(config.provider).pipe(
		Match.when("ollama", () =>
			ollamaLanguageModelLayer(config.model, {
				host: DEFAULT_OLLAMA_HOST,
				...(options?.fetch !== undefined && { fetch: options.fetch }),
			}),
		),
		Match.when("github-models", () => {
			if (!config.ghToken || !config.model) {
				return Layer.effect(
					LanguageModel.LanguageModel,
					Effect.fail(
						new AutoPrConfigError({
							missing: ["GH_TOKEN and AUTO_PR_AI_GITHUB_MODEL required for github-models"],
						}),
					),
				);
			}
			const clientLayer = OpenAiClient.layer({
				apiUrl: GITHUB_MODELS_INFERENCE_URL,
				apiKey: config.ghToken,
			}).pipe(Layer.provide(FetchHttpClient.layer));
			const modelLayer = OpenAiLanguageModel.model(config.model);
			return modelLayer.pipe(Layer.provide(clientLayer));
		}),
		Match.when("openai-compat", () => notImplemented("openai-compat")),
		Match.exhaustive,
	);
}
