/**
 * AI provider layer factory. Builds Layer<LanguageModel> from config.
 * Dispatches by AUTO_PR_AI_PROVIDER; only ollama implemented (github-models, openai-compat deferred).
 *
 * Spec: docs/superpowers/specs/2025-03-22-ai-abstraction-layer-design.md
 */

import { Effect, Layer, Match } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import type { AiProvider } from "#auto-pr/config.js";
import { AutoPrConfigError } from "#auto-pr/errors.js";
import { ollamaLanguageModelLayer } from "#auto-pr/live/ollama-language-model.js";

const DEFAULT_OLLAMA_HOST = "http://localhost:11434";

const notImplemented = (provider: string) =>
	Layer.effect(
		LanguageModel.LanguageModel,
		Effect.fail(
			new AutoPrConfigError({
				missing: [`AUTO_PR_AI_PROVIDER=${provider} not yet implemented. Use ollama.`],
			}),
		),
	);

/** Minimal config for AI provider layer (provider + model). */
export interface AiProviderConfig {
	readonly provider: AiProvider;
	readonly model: string;
}

/**
 * Build Layer<LanguageModel> from provider config.
 * Only ollama supported; github-models and openai-compat fail with AutoPrConfigError.
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
		Match.when("github-models", () => notImplemented("github-models")),
		Match.when("openai-compat", () => notImplemented("openai-compat")),
		Match.exhaustive,
	);
}
