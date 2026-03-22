/**
 * AI provider layer factory. Builds Layer<LanguageModel> from config.
 * Dispatches by AUTO_PR_AI_PROVIDER: ollama, github-models, openai-compat (OpenAI-compatible APIs).
 *
 * Spec: docs/superpowers/specs/2026-03-22-ai-abstraction-layer-design.md
 * ADR: docs/adr/0007-ai-abstraction-layer.md
 */

import * as OpenAiClient from "@effect/ai-openai-compat/OpenAiClient";
import * as OpenAiLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel";
import type { Redacted } from "effect";
import { Effect, Layer, Match, Redacted as RedactedValue } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import type { AiProvider } from "#auto-pr/config.js";
import { AutoPrConfigError } from "#auto-pr/errors.js";
import { ollamaLanguageModelLayer } from "#auto-pr/live/ollama-language-model.js";

const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
const GITHUB_MODELS_INFERENCE_URL = "https://models.github.ai/inference";

/** Config for AI provider layer (provider, model, and provider-specific fields). */
export interface AiProviderConfig {
	readonly provider: AiProvider;
	readonly model: string;
	/** Required when `provider` is `github-models`. */
	readonly ghToken?: Redacted.Redacted<string>;
	/** Required when `provider` is `openai-compat`. */
	readonly openaiCompatUrl?: string;
	readonly openaiCompatApiKey?: Redacted.Redacted<string>;
	readonly openaiCompatModel?: string;
}

/**
 * Build Layer<LanguageModel> from provider config.
 * Supports ollama, github-models, and openai-compat.
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
			if (!config.ghToken || RedactedValue.value(config.ghToken).trim() === "" || !config.model) {
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
		Match.when("openai-compat", () => {
			if (
				!config.openaiCompatUrl ||
				!config.openaiCompatApiKey ||
				RedactedValue.value(config.openaiCompatApiKey).trim() === "" ||
				!config.openaiCompatModel
			) {
				return Layer.effect(
					LanguageModel.LanguageModel,
					Effect.fail(
						new AutoPrConfigError({
							missing: [
								"AUTO_PR_AI_OPENAI_COMPAT_URL, AUTO_PR_AI_OPENAI_COMPAT_API_KEY, AUTO_PR_AI_OPENAI_COMPAT_MODEL required for openai-compat",
							],
						}),
					),
				);
			}
			const clientLayer = OpenAiClient.layer({
				apiUrl: config.openaiCompatUrl,
				apiKey: config.openaiCompatApiKey,
			}).pipe(Layer.provide(FetchHttpClient.layer));
			const modelLayer = OpenAiLanguageModel.model(config.openaiCompatModel);
			return modelLayer.pipe(Layer.provide(clientLayer));
		}),
		Match.exhaustive,
	);
}
