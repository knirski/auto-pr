/**
 * AI provider layer factory. Builds Layer<LanguageModel> from config.
 * Providers: `local` (any local LLM via OpenAI-compatible HTTP — e.g. llama.cpp), `github-models`.
 *
 * Both use `@effect/ai-openai-compat` (`OpenAiClient.layer` + `OpenAiLanguageModel.model`) + `FetchHttpClient`.
 * Outgoing HTTP matches the OpenAI Chat Completions API (`POST …/v1/chat/completions`); see
 * https://platform.openai.com/docs/api-reference/chat/create and `@effect/ai-openai-compat` — no duplicate request-shape logic here.
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
import { DEFAULT_OPENAI_COMPAT_URL } from "#auto-pr/config.js";
import { AutoPrConfigError } from "#core/errors.js";

const GITHUB_MODELS_INFERENCE_URL = "https://models.github.ai/inference";

export type AiProviderConfigLocal = {
	readonly provider: "local";
	readonly model: string;
	/** Base URL for OpenAI-compatible `/v1/...`; defaults when omitted for direct tests. */
	readonly openaiCompatUrl?: string;
	readonly openaiCompatApiKey?: Redacted.Redacted<string>;
};

export type AiProviderConfigGithubModels = {
	readonly provider: "github-models";
	readonly model: string;
	readonly ghToken: Redacted.Redacted<string>;
};

/** Config for AI provider layer (provider, model, and provider-specific fields). */
export type AiProviderConfig = AiProviderConfigLocal | AiProviderConfigGithubModels;

function openAiLanguageModelStack(
	clientOptions: OpenAiClient.Options,
	modelId: string,
	fetchOverrideLayer: Layer.Layer<never>,
) {
	const clientLayer = OpenAiClient.layer(clientOptions).pipe(Layer.provide(FetchHttpClient.layer));
	const modelLayer = OpenAiLanguageModel.model(modelId);
	return Layer.mergeAll(fetchOverrideLayer, modelLayer.pipe(Layer.provide(clientLayer)));
}

function redactedHasText(
	value: Redacted.Redacted<string> | undefined,
): value is Redacted.Redacted<string> {
	return value !== undefined && RedactedValue.value(value).trim() !== "";
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

	return Match.value(config).pipe(
		Match.when({ provider: "local" }, (local) => {
			const apiUrl = local.openaiCompatUrl ?? DEFAULT_OPENAI_COMPAT_URL;
			const apiKey = local.openaiCompatApiKey;
			const clientOptions: OpenAiClient.Options = {
				apiUrl,
				...(redactedHasText(apiKey) ? { apiKey } : {}),
			};
			return openAiLanguageModelStack(clientOptions, local.model, fetchOverrideLayer);
		}),
		Match.when({ provider: "github-models" }, (githubModels) => {
			if (!redactedHasText(githubModels.ghToken) || githubModels.model.trim() === "") {
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
			return openAiLanguageModelStack(
				{
					apiUrl: GITHUB_MODELS_INFERENCE_URL,
					apiKey: githubModels.ghToken,
				},
				githubModels.model,
				fetchOverrideLayer,
			);
		}),
		Match.exhaustive,
	);
}
