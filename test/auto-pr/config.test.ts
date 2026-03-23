import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Cause, ConfigProvider, Effect, Exit, Layer, Redacted, Result } from "effect";
import {
	AutoPrConfigError,
	CreateOrUpdatePrConfig,
	CreateOrUpdatePrConfigLayer,
	GeneratePrContentConfig,
	GeneratePrContentConfigLayer,
	GetCommitsConfig,
	GetCommitsConfigLayer,
	RunAutoPrConfig,
	RunAutoPrConfigLayer,
} from "#auto-pr";
import { runEffect } from "#test/run-effect.js";
import { createTestTempDirEffect, TestBaseLayer } from "#test/test-utils.js";

/** Empty config provider so required env vars are missing. */
const EmptyConfigProviderLayer = ConfigProvider.layer(ConfigProvider.fromUnknown({}));

function expectConfigFailure<A>(
	effect: Effect.Effect<A, unknown, A>,
	configLayer: Layer.Layer<A, unknown, never>,
): Effect.Effect<void> {
	return effect
		.pipe(Effect.provide(configLayer), Effect.provide(EmptyConfigProviderLayer), Effect.exit)
		.pipe(Effect.flatMap((exit) => Effect.sync(() => expect(Exit.isFailure(exit)).toBe(true))));
}

const GetCommitsConfigProviderLayer = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		DEFAULT_BRANCH: "main",
		GITHUB_WORKSPACE: "/workspace",
		GITHUB_OUTPUT: "/tmp/gh-output",
	}),
);

const GetCommitsLayer = Layer.mergeAll(
	TestBaseLayer,
	GetCommitsConfigLayer.pipe(Layer.provide(GetCommitsConfigProviderLayer)),
);

describe("GetCommitsConfigLayer succeeds when all vars present", () => {
	test("returns config with non-empty values", async () => {
		await runEffect(GetCommitsLayer)(
			Effect.gen(function* () {
				const config = yield* GetCommitsConfig;
				expect(config.defaultBranch).toBe("main");
				expect(config.workspace).toBe("/workspace");
				expect(config.ghOutput).toBe("/tmp/gh-output");
			}),
		);
	});
});

const GeneratePrContentConfigProviderLayer = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		GITHUB_WORKSPACE: "/workspace",
		AUTO_PR_AI_OLLAMA_MODEL: "llama3.1:8b",
	}),
);

const GeneratePrContentLayer = Layer.mergeAll(
	TestBaseLayer,
	GeneratePrContentConfigLayer.pipe(Layer.provide(GeneratePrContentConfigProviderLayer)),
);

describe("GeneratePrContentConfigLayer succeeds when all vars present", () => {
	test("returns config with non-empty values", async () => {
		await runEffect(GeneratePrContentLayer)(
			Effect.gen(function* () {
				const config = yield* GeneratePrContentConfig;
				expect(config.commits).toBe(join("/workspace", "commits.txt"));
				expect(config.files).toBe(join("/workspace", "files.txt"));
				expect(config.templatePath).toBe(join("/workspace", ".github/PULL_REQUEST_TEMPLATE.md"));
				expect(config.provider).toBe("ollama");
				expect(config.model).toBe("llama3.1:8b");
			}),
		);
	});
});

const generatePrContentBaseEnv = {
	GITHUB_WORKSPACE: "/workspace",
};

describe("GeneratePrContentConfigLayer for github-models", () => {
	test("succeeds with GH_TOKEN and AUTO_PR_AI_GITHUB_MODEL", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				...generatePrContentBaseEnv,
				AUTO_PR_AI_PROVIDER: "github-models",
				GH_TOKEN: "ghp_test_github_models",
				AUTO_PR_AI_GITHUB_MODEL: "openai/gpt-4.1",
			}),
		);
		const layer = Layer.mergeAll(
			TestBaseLayer,
			GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
		);
		await runEffect(layer)(
			Effect.gen(function* () {
				const config = yield* GeneratePrContentConfig;
				expect(config.provider).toBe("github-models");
				expect(config.model).toBe("openai/gpt-4.1");
				expect(config.githubModel).toBe("openai/gpt-4.1");
				expect(config.ghToken).toBeDefined();
				expect(Redacted.isRedacted(config.ghToken)).toBe(true);
			}),
		);
	});

	test("fails when GH_TOKEN missing", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				...generatePrContentBaseEnv,
				AUTO_PR_AI_PROVIDER: "github-models",
				AUTO_PR_AI_GITHUB_MODEL: "openai/gpt-4.1",
			}),
		);
		const layer = Layer.mergeAll(
			TestBaseLayer,
			GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
		);
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
				onSuccess: (err) => {
					expect(err).toBeInstanceOf(AutoPrConfigError);
					expect((err as AutoPrConfigError).missing.join(" ")).toContain("GH_TOKEN");
				},
				onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
			});
		}
	});
});

describe("GeneratePrContentConfigLayer for openai-compat", () => {
	test("succeeds with all AUTO_PR_AI_OPENAI_COMPAT_* vars", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				...generatePrContentBaseEnv,
				AUTO_PR_AI_PROVIDER: "openai-compat",
				AUTO_PR_AI_OPENAI_COMPAT_URL: "https://api.openrouter.ai/v1",
				AUTO_PR_AI_OPENAI_COMPAT_API_KEY: "sk-or-test",
				AUTO_PR_AI_OPENAI_COMPAT_MODEL: "meta-llama/llama-3.1-8b-instruct",
			}),
		);
		const layer = Layer.mergeAll(
			TestBaseLayer,
			GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
		);
		await runEffect(layer)(
			Effect.gen(function* () {
				const config = yield* GeneratePrContentConfig;
				expect(config.provider).toBe("openai-compat");
				expect(config.model).toBe("meta-llama/llama-3.1-8b-instruct");
				expect(config.openaiCompatUrl).toBe("https://api.openrouter.ai/v1");
				expect(config.openaiCompatModel).toBe("meta-llama/llama-3.1-8b-instruct");
				expect(Redacted.isRedacted(config.openaiCompatApiKey)).toBe(true);
			}),
		);
	});

	test("fails when AUTO_PR_AI_OPENAI_COMPAT_URL missing", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				...generatePrContentBaseEnv,
				AUTO_PR_AI_PROVIDER: "openai-compat",
				AUTO_PR_AI_OPENAI_COMPAT_API_KEY: "sk-test",
				AUTO_PR_AI_OPENAI_COMPAT_MODEL: "gpt-4",
			}),
		);
		const layer = Layer.mergeAll(
			TestBaseLayer,
			GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
		);
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
				onSuccess: (err) => {
					expect(err).toBeInstanceOf(AutoPrConfigError);
					expect((err as AutoPrConfigError).missing.join(" ")).toContain(
						"AUTO_PR_AI_OPENAI_COMPAT_URL",
					);
				},
				onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
			});
		}
	});
});

describe("CreateOrUpdatePrConfigLayer succeeds when all vars present", () => {
	test("returns config with ghToken redacted", async () => {
		await runEffect(TestBaseLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("cou-pr-");
				yield* tmp.writeFile(join(tmp.path, "pr-title.txt"), "feat: add x\n");
				const providerLayer = ConfigProvider.layer(
					ConfigProvider.fromUnknown({
						BRANCH: "ai/feature",
						DEFAULT_BRANCH: "main",
						GITHUB_WORKSPACE: tmp.path,
						GH_TOKEN: "ghp_test_token",
					}),
				);
				const fullLayer = Layer.mergeAll(
					TestBaseLayer,
					CreateOrUpdatePrConfigLayer.pipe(Layer.provide(providerLayer)),
				);
				return yield* Effect.gen(function* () {
					const config = yield* CreateOrUpdatePrConfig;
					expect(config.branch).toBe("ai/feature");
					expect(config.title).toBe("feat: add x");
					expect(config.bodyFile).toBe(join(tmp.path, "pr-body.md"));
					expect(Redacted.isRedacted(config.ghToken)).toBe(true);
				}).pipe(Effect.provide(fullLayer));
			}).pipe(Effect.scoped),
		);
	});
});

describe("config layers fail when required env vars missing", () => {
	test("GetCommitsConfigLayer fails when GITHUB_OUTPUT missing", async () => {
		await Effect.runPromise(
			expectConfigFailure(
				Effect.gen(function* () {
					return yield* GetCommitsConfig;
				}),
				GetCommitsConfigLayer,
			),
		);
	});

	test("GeneratePrContentConfigLayer fails when GITHUB_WORKSPACE missing", async () => {
		await Effect.runPromise(
			expectConfigFailure(
				Effect.gen(function* () {
					return yield* GeneratePrContentConfig;
				}),
				GeneratePrContentConfigLayer,
			),
		);
	});

	test("CreateOrUpdatePrConfigLayer fails when required vars missing", async () => {
		await Effect.runPromise(
			expectConfigFailure(
				Effect.gen(function* () {
					return yield* CreateOrUpdatePrConfig;
				}),
				CreateOrUpdatePrConfigLayer.pipe(Layer.provideMerge(TestBaseLayer)),
			),
		);
	});

	test("RunAutoPrConfigLayer fails when GH_TOKEN missing", async () => {
		await Effect.runPromise(
			expectConfigFailure(
				Effect.gen(function* () {
					return yield* RunAutoPrConfig;
				}),
				RunAutoPrConfigLayer,
			),
		);
	});
});
