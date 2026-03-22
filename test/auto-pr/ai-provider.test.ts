import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Redacted, Result } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { AutoPrConfigError } from "#auto-pr";
import { aiProviderLayerFromConfig } from "#auto-pr/live/ai-provider.js";
import { runEffect } from "#test/run-effect.js";
import { createOllamaMockFetch, SilentLoggerLayer, TestBaseLayer } from "#test/test-utils.js";

const BaseLayer = Layer.mergeAll(TestBaseLayer, SilentLoggerLayer);

describe("aiProviderLayerFromConfig", () => {
	test("ollama: builds layer that provides LanguageModel", async () => {
		const layer = Layer.mergeAll(
			BaseLayer,
			aiProviderLayerFromConfig(
				{ provider: "ollama", model: "llama3.1:8b" },
				{ fetch: createOllamaMockFetch("") },
			),
		);
		await runEffect(layer)(
			Effect.gen(function* () {
				const model = yield* LanguageModel.LanguageModel;
				expect(model).toBeDefined();
			}).pipe(Effect.scoped),
		);
	});

	test("github-models: builds layer when ghToken and model provided", async () => {
		const layer = Layer.mergeAll(
			BaseLayer,
			aiProviderLayerFromConfig({
				provider: "github-models",
				model: "openai/gpt-4",
				ghToken: Redacted.make("ghp_test", { label: "GH_TOKEN" }),
			}),
		);
		await runEffect(layer)(
			Effect.gen(function* () {
				const model = yield* LanguageModel.LanguageModel;
				expect(model).toBeDefined();
			}).pipe(Effect.scoped),
		);
	});

	test("github-models: fails with AutoPrConfigError when ghToken missing", async () => {
		const layer = Layer.mergeAll(
			BaseLayer,
			aiProviderLayerFromConfig({ provider: "github-models", model: "openai/gpt-4" }),
		);
		const exit = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* LanguageModel.LanguageModel;
			}).pipe(Effect.scoped, Effect.provide(layer), Effect.exit),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			Result.match(Cause.findError(exit.cause), {
				onSuccess: (err) => expect(err).toBeInstanceOf(AutoPrConfigError),
				onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
			});
		}
	});

	test("openai-compat: builds layer when url, apiKey, and model provided", async () => {
		const layer = Layer.mergeAll(
			BaseLayer,
			aiProviderLayerFromConfig({
				provider: "openai-compat",
				model: "gpt-4",
				openaiCompatUrl: "https://api.example.com/v1",
				openaiCompatApiKey: Redacted.make("sk-test", {
					label: "AUTO_PR_AI_OPENAI_COMPAT_API_KEY",
				}),
				openaiCompatModel: "gpt-4",
			}),
		);
		await runEffect(layer)(
			Effect.gen(function* () {
				const model = yield* LanguageModel.LanguageModel;
				expect(model).toBeDefined();
			}).pipe(Effect.scoped),
		);
	});

	test("openai-compat: fails with AutoPrConfigError when url missing", async () => {
		const layer = Layer.mergeAll(
			BaseLayer,
			aiProviderLayerFromConfig({
				provider: "openai-compat",
				model: "gpt-4",
				openaiCompatApiKey: Redacted.make("sk-test", {
					label: "AUTO_PR_AI_OPENAI_COMPAT_API_KEY",
				}),
				openaiCompatModel: "gpt-4",
			}),
		);
		const exit = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* LanguageModel.LanguageModel;
			}).pipe(Effect.scoped, Effect.provide(layer), Effect.exit),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			Result.match(Cause.findError(exit.cause), {
				onSuccess: (err) => expect(err).toBeInstanceOf(AutoPrConfigError),
				onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
			});
		}
	});
});
