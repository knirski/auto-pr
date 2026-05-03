import { describe, expect, test } from "bun:test";
import { Cause, ConfigProvider, Effect, Exit, Layer, Result } from "effect";
import { AutoPrConfigError, GeneratePrContentConfig, GeneratePrContentConfigLayer } from "#auto-pr";
import { runEffect } from "#test/run-effect.js";
import { TestBaseLayer } from "#test/test-utils.js";

const baseEnv = {
	GITHUB_WORKSPACE: "/workspace",
	DEFAULT_BRANCH: "main",
	BRANCH: "ai/feature",
	AUTO_PR_AI_PROVIDER: "github-models",
	GH_TOKEN: "ghp_test_github_models",
	AUTO_PR_AI_OPENAI_COMPAT_MODEL: "openai/gpt-4.1",
};

function makeLayer(env: Record<string, string>) {
	return Layer.mergeAll(
		TestBaseLayer,
		GeneratePrContentConfigLayer.pipe(
			Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
		),
	);
}

describe("GeneratePrContentConfigLayer ai fallback strategy", () => {
	test("accepts and trims AUTO_PR_AI_FALLBACK_STRATEGY", async () => {
		const layer = makeLayer({
			...baseEnv,
			AUTO_PR_AI_FALLBACK_STRATEGY: "  local-only ",
		});
		await runEffect(layer)(
			Effect.gen(function* () {
				const config = yield* GeneratePrContentConfig;
				expect(config.provider).toBe("github-models");
				expect(config.aiFallbackStrategy).toBe("local-only");
			}),
		);
	});

	test("treats blank AUTO_PR_AI_FALLBACK_STRATEGY as undefined", async () => {
		const layer = makeLayer({
			...baseEnv,
			AUTO_PR_AI_FALLBACK_STRATEGY: "   ",
		});
		await runEffect(layer)(
			Effect.gen(function* () {
				const config = yield* GeneratePrContentConfig;
				expect(config.provider).toBe("github-models");
				expect(config.aiFallbackStrategy).toBeUndefined();
			}),
		);
	});

	test("fails on invalid AUTO_PR_AI_FALLBACK_STRATEGY", async () => {
		const layer = makeLayer({
			...baseEnv,
			AUTO_PR_AI_FALLBACK_STRATEGY: "foo",
		});
		const exit = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* GeneratePrContentConfig;
			})
				.pipe(Effect.provide(layer))
				.pipe(Effect.exit),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			Result.match(Cause.findError(exit.cause), {
				onSuccess: (error) => {
					expect(error).toBeInstanceOf(AutoPrConfigError);
					expect((error as AutoPrConfigError).missing.join(" ")).toContain(
						"Invalid AUTO_PR_AI_FALLBACK_STRATEGY: foo",
					);
				},
				onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
			});
		}
	});
});
