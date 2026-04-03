/**
 * Real HTTP integration tests for AI providers. Disabled unless env flags are set
 * (see `.github/workflows/integration.yml`). Normal `bun test` skips these via describe.skipIf.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Layer, Redacted, Schema } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { aiProviderLayerFromConfig } from "#auto-pr";
import { runEffect } from "#test/run-effect.js";
import { TestBaseLayer } from "#test/test-utils.js";

const runLocal = process.env.AUTO_PR_INTEGRATION_LOCAL === "1";
const runGithubModels = process.env.AUTO_PR_INTEGRATION_GITHUB_MODELS === "1";

/** Minimal structured output to verify `generateObject` against GitHub Models. */
const SmokeObjectSchema = Schema.Struct({
	word: Schema.String,
});

function layerLocal(model: string, openaiCompatUrl: string) {
	return Layer.mergeAll(
		TestBaseLayer,
		aiProviderLayerFromConfig({
			provider: "local",
			model,
			openaiCompatUrl,
		}),
	);
}

function layerGithubModels(model: string, ghToken: string) {
	return Layer.mergeAll(
		TestBaseLayer,
		aiProviderLayerFromConfig({
			provider: "github-models",
			model,
			ghToken: Redacted.make(ghToken),
		}),
	);
}

describe.skipIf(!runLocal)("integration: local OpenAI-compat (llama.cpp)", () => {
	test(
		"generateText returns non-empty assistant text",
		async () => {
			const url = process.env.AUTO_PR_AI_OPENAI_COMPAT_URL;
			const model = process.env.AUTO_PR_AI_OPENAI_COMPAT_MODEL;
			if (url === undefined || url === "") {
				throw new Error("AUTO_PR_AI_OPENAI_COMPAT_URL is required for local integration");
			}
			if (model === undefined || model === "") {
				throw new Error("AUTO_PR_AI_OPENAI_COMPAT_MODEL is required for local integration");
			}
			const layer = layerLocal(model, url);
			await runEffect(layer)(
				Effect.gen(function* () {
					const res = yield* LanguageModel.generateText({
						prompt: "Reply with a single word: ok",
					});
					expect(res.text.trim().length).toBeGreaterThan(0);
				}),
			);
		},
		{ timeout: 180_000 },
	);
});

describe.skipIf(!runGithubModels)("integration: github-models", () => {
	test(
		"generateObject returns structured JSON",
		async () => {
			const model = process.env.AUTO_PR_AI_OPENAI_COMPAT_MODEL ?? "microsoft/phi-4-mini-instruct";
			const token = process.env.GH_TOKEN;
			if (token === undefined || token === "") {
				throw new Error("GH_TOKEN is required for github-models integration");
			}
			const layer = layerGithubModels(model, token);
			await runEffect(layer)(
				Effect.gen(function* () {
					const res = yield* LanguageModel.generateObject({
						prompt:
							'Return a JSON object with a single string field "word" whose value is the text "pong".',
						schema: SmokeObjectSchema,
					});
					expect(res.value.word.toLowerCase()).toContain("pong");
				}),
			);
		},
		{ timeout: 180_000 },
	);
});
