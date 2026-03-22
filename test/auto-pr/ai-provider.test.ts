import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Result } from "effect";
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

	test("github-models: layer fails with AutoPrConfigError", async () => {
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

	test("openai-compat: layer fails with AutoPrConfigError", async () => {
		const layer = Layer.mergeAll(
			BaseLayer,
			aiProviderLayerFromConfig({ provider: "openai-compat", model: "gpt-4" }),
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
