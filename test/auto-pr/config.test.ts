import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Cause, ConfigProvider, Effect, Exit, Layer, Redacted, Result } from "effect";
import {
	AutoPrConfigError,
	CreateOrUpdatePrConfig,
	CreateOrUpdatePrConfigLayer,
	DEFAULT_GITHUB_MODELS_MODEL,
	DEFAULT_OPENAI_COMPAT_MODEL,
	DEFAULT_OPENAI_COMPAT_URL,
	GeneratePrContentConfig,
	GeneratePrContentConfigLayer,
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

const GeneratePrContentConfigProviderLayer = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		GITHUB_WORKSPACE: "/workspace",
		DEFAULT_BRANCH: "main",
		BRANCH: "ai/feature",
		AUTO_PR_AI_OPENAI_COMPAT_MODEL: "llama3.1:8b",
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
				expect(config.templatePath).toBe(join("/workspace", ".github/PULL_REQUEST_TEMPLATE.md"));
				expect(config.provider).toBe("local");
				expect(config.model).toBe("llama3.1:8b");
				expect(config.existingPrTitle).toBeUndefined();
			}),
		);
	});

	test("trims AUTO_PR_EXISTING_PR_TITLE when present", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				GITHUB_WORKSPACE: "/workspace",
				DEFAULT_BRANCH: "main",
				BRANCH: "ai/feature",
				AUTO_PR_AI_OPENAI_COMPAT_MODEL: "llama3.1:8b",
				AUTO_PR_EXISTING_PR_TITLE: "  feat: existing title  ",
			}),
		);
		const layer = Layer.mergeAll(
			TestBaseLayer,
			GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
		);
		await runEffect(layer)(
			Effect.gen(function* () {
				const config = yield* GeneratePrContentConfig;
				expect(config.existingPrTitle).toBe("feat: existing title");
			}),
		);
	});

	test("ignores blank AUTO_PR_EXISTING_PR_TITLE", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				GITHUB_WORKSPACE: "/workspace",
				DEFAULT_BRANCH: "main",
				BRANCH: "ai/feature",
				AUTO_PR_AI_OPENAI_COMPAT_MODEL: "llama3.1:8b",
				AUTO_PR_EXISTING_PR_TITLE: " \t ",
			}),
		);
		const layer = Layer.mergeAll(
			TestBaseLayer,
			GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
		);
		await runEffect(layer)(
			Effect.gen(function* () {
				const config = yield* GeneratePrContentConfig;
				expect(config.existingPrTitle).toBeUndefined();
			}),
		);
	});
});

const generatePrContentBaseEnv = {
	GITHUB_WORKSPACE: "/workspace",
	DEFAULT_BRANCH: "main",
	BRANCH: "ai/feature",
};

describe("GeneratePrContentConfigLayer for github-models", () => {
	test("succeeds with GH_TOKEN and AUTO_PR_AI_OPENAI_COMPAT_MODEL", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				...generatePrContentBaseEnv,
				AUTO_PR_AI_PROVIDER: "github-models",
				GH_TOKEN: "ghp_test_github_models",
				AUTO_PR_AI_OPENAI_COMPAT_MODEL: "openai/gpt-4.1",
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
				if (config.provider !== "github-models") return expect().fail("expected github-models");
				expect(config.ghToken).toBeDefined();
				expect(Redacted.isRedacted(config.ghToken)).toBe(true);
			}),
		);
	});

	test("uses default model when AUTO_PR_AI_OPENAI_COMPAT_MODEL omitted", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				...generatePrContentBaseEnv,
				AUTO_PR_AI_PROVIDER: "github-models",
				GH_TOKEN: "ghp_test_github_models",
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
				expect(config.model).toBe(DEFAULT_GITHUB_MODELS_MODEL);
			}),
		);
	});

	test("fails when GH_TOKEN missing", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				...generatePrContentBaseEnv,
				AUTO_PR_AI_PROVIDER: "github-models",
				AUTO_PR_AI_OPENAI_COMPAT_MODEL: "openai/gpt-4.1",
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

describe("GeneratePrContentConfigLayer for local", () => {
	test("succeeds with all AUTO_PR_AI_OPENAI_COMPAT_* vars", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				...generatePrContentBaseEnv,
				AUTO_PR_AI_PROVIDER: "local",
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
				expect(config.provider).toBe("local");
				if (config.provider !== "local") return expect().fail("expected local");
				expect(config.model).toBe("meta-llama/llama-3.1-8b-instruct");
				expect(config.openaiCompatUrl).toBe("https://api.openrouter.ai/v1");
				expect(Redacted.isRedacted(config.openaiCompatApiKey)).toBe(true);
			}),
		);
	});

	test("uses default AUTO_PR_AI_OPENAI_COMPAT_URL when omitted", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				...generatePrContentBaseEnv,
				AUTO_PR_AI_PROVIDER: "local",
				AUTO_PR_AI_OPENAI_COMPAT_API_KEY: "sk-test",
				AUTO_PR_AI_OPENAI_COMPAT_MODEL: "gpt-4",
			}),
		);
		const layer = Layer.mergeAll(
			TestBaseLayer,
			GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
		);
		await runEffect(layer)(
			Effect.gen(function* () {
				const config = yield* GeneratePrContentConfig;
				expect(config.provider).toBe("local");
				if (config.provider !== "local") return expect().fail("expected local");
				expect(config.openaiCompatUrl).toBe(DEFAULT_OPENAI_COMPAT_URL);
			}),
		);
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

	test("CreateOrUpdatePrConfigLayer fails when pr-title.txt is missing", async () => {
		await runEffect(TestBaseLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("cou-pr-no-title-");
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
				const exit = yield* Effect.gen(function* () {
					return yield* CreateOrUpdatePrConfig;
				})
					.pipe(Effect.provide(fullLayer))
					.pipe(Effect.exit);
				expect(Exit.isFailure(exit)).toBe(true);
				if (Exit.isFailure(exit)) {
					Result.match(Cause.findError(exit.cause), {
						onSuccess: (err) => {
							expect(err).toBeInstanceOf(AutoPrConfigError);
							expect((err as AutoPrConfigError).missing.join(" ")).toContain("pr-title.txt");
						},
						onFailure: () => expect().fail("expected AutoPrConfigError"),
					});
				}
			}).pipe(Effect.scoped),
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

const runAutoPrBaseEnv = {
	DEFAULT_BRANCH: "main",
	GITHUB_WORKSPACE: "/run-auto-pr-ws",
	GH_TOKEN: "ghp_run_auto_pr",
};

describe("RunAutoPrConfigLayer succeeds", () => {
	test("with local provider (default) and model", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				...runAutoPrBaseEnv,
				AUTO_PR_AI_OPENAI_COMPAT_MODEL: "gpt-oss",
			}),
		);
		const layer = Layer.mergeAll(
			TestBaseLayer,
			RunAutoPrConfigLayer.pipe(Layer.provide(providerLayer)),
		);
		await runEffect(layer)(
			Effect.gen(function* () {
				const config = yield* RunAutoPrConfig;
				expect(config.provider).toBe("local");
				if (config.provider === "local") {
					expect(config.model).toBe("gpt-oss");
					expect(config.openaiCompatUrl).toBe(DEFAULT_OPENAI_COMPAT_URL);
				}
				expect(config.branch).toBeUndefined();
				expect(config.existingPrTitle).toBeUndefined();
			}),
		);
	});

	test("trims AUTO_PR_EXISTING_PR_TITLE", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				...runAutoPrBaseEnv,
				AUTO_PR_AI_OPENAI_COMPAT_MODEL: "gpt-oss",
				AUTO_PR_EXISTING_PR_TITLE: "  feat: run existing  ",
			}),
		);
		const layer = Layer.mergeAll(
			TestBaseLayer,
			RunAutoPrConfigLayer.pipe(Layer.provide(providerLayer)),
		);
		await runEffect(layer)(
			Effect.gen(function* () {
				const config = yield* RunAutoPrConfig;
				expect(config.existingPrTitle).toBe("feat: run existing");
			}),
		);
	});

	test("with github-models provider and default model", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				...runAutoPrBaseEnv,
				AUTO_PR_AI_PROVIDER: "github-models",
			}),
		);
		const layer = Layer.mergeAll(
			TestBaseLayer,
			RunAutoPrConfigLayer.pipe(Layer.provide(providerLayer)),
		);
		await runEffect(layer)(
			Effect.gen(function* () {
				const config = yield* RunAutoPrConfig;
				expect(config.provider).toBe("github-models");
				expect(config.model).toBe(DEFAULT_GITHUB_MODELS_MODEL);
				expect("openaiCompatUrl" in config).toBe(false);
			}),
		);
	});
});

describe("RunAutoPrConfigLayer rejects invalid AUTO_PR_AI_OPENAI_COMPAT_URL", () => {
	test("fails when URL lacks scheme (local provider)", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				...runAutoPrBaseEnv,
				AUTO_PR_AI_PROVIDER: "local",
				AUTO_PR_AI_OPENAI_COMPAT_URL: "localhost:8080/v1",
				AUTO_PR_AI_OPENAI_COMPAT_MODEL: "gpt-oss",
			}),
		);
		const layer = Layer.mergeAll(
			TestBaseLayer,
			RunAutoPrConfigLayer.pipe(Layer.provide(providerLayer)),
		);
		const exit = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* RunAutoPrConfig;
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

describe("GeneratePrContentConfig reads DEFAULT_BRANCH and BRANCH", () => {
	test("reads DEFAULT_BRANCH and BRANCH from env", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				GITHUB_WORKSPACE: "/tmp/ws",
				AUTO_PR_AI_PROVIDER: "local",
				AUTO_PR_AI_OPENAI_COMPAT_MODEL: "gpt-oss",
				DEFAULT_BRANCH: "main",
				BRANCH: "ai/test-branch",
			}),
		);
		const layer = Layer.mergeAll(
			TestBaseLayer,
			GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
		);
		await runEffect(layer)(
			Effect.gen(function* () {
				const config = yield* GeneratePrContentConfig;
				expect(config.defaultBranch).toBe("main");
				expect(config.branch).toBe("ai/test-branch");
			}),
		);
	});
});

describe("GeneratePrContentConfigLayer rejects invalid provider", () => {
	test("fails when AUTO_PR_AI_PROVIDER is not local or github-models", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				GITHUB_WORKSPACE: "/workspace",
				DEFAULT_BRANCH: "main",
				BRANCH: "ai/feature",
				AUTO_PR_AI_PROVIDER: "ollama",
				AUTO_PR_AI_OPENAI_COMPAT_MODEL: "m",
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
						"Invalid AUTO_PR_AI_PROVIDER",
					);
				},
				onFailure: () => expect().fail("expected AutoPrConfigError"),
			});
		}
	});
});

describe("GeneratePrContentConfigLayer rejects branch === defaultBranch", () => {
	test("fails when BRANCH equals DEFAULT_BRANCH", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				GITHUB_WORKSPACE: "/workspace",
				DEFAULT_BRANCH: "main",
				BRANCH: "main",
				AUTO_PR_AI_OPENAI_COMPAT_MODEL: "gpt-oss",
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
					expect((err as AutoPrConfigError).missing.join(" ")).toContain("BRANCH");
					expect((err as AutoPrConfigError).missing.join(" ")).toContain("DEFAULT_BRANCH");
				},
				onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
			});
		}
	});
});

describe("RunAutoPrConfigLayer rejects branch === defaultBranch when BRANCH is set", () => {
	test("fails when BRANCH equals DEFAULT_BRANCH", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				...runAutoPrBaseEnv,
				BRANCH: "main",
				AUTO_PR_AI_OPENAI_COMPAT_MODEL: "gpt-oss",
			}),
		);
		const layer = Layer.mergeAll(
			TestBaseLayer,
			RunAutoPrConfigLayer.pipe(Layer.provide(providerLayer)),
		);
		const exit = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* RunAutoPrConfig;
			})
				.pipe(Effect.provide(layer))
				.pipe(Effect.exit),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			Result.match(Cause.findError(exit.cause), {
				onSuccess: (err) => {
					expect(err).toBeInstanceOf(AutoPrConfigError);
					expect((err as AutoPrConfigError).missing.join(" ")).toContain("BRANCH");
				},
				onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
			});
		}
	});

	test("succeeds when BRANCH is not set (optional in RunAutoPr)", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				...runAutoPrBaseEnv,
				AUTO_PR_AI_OPENAI_COMPAT_MODEL: "gpt-oss",
				// No BRANCH set
			}),
		);
		const layer = Layer.mergeAll(
			TestBaseLayer,
			RunAutoPrConfigLayer.pipe(Layer.provide(providerLayer)),
		);
		await runEffect(layer)(
			Effect.gen(function* () {
				const config = yield* RunAutoPrConfig;
				expect(config.branch).toBeUndefined();
			}),
		);
	});
});

describe("GeneratePrContentConfigLayer uses default values and logs warnings", () => {
	test("fails when AUTO_PR_AI_OPENAI_COMPAT_URL lacks scheme (local provider)", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				...generatePrContentBaseEnv,
				AUTO_PR_AI_PROVIDER: "local",
				AUTO_PR_AI_OPENAI_COMPAT_URL: "localhost:8080/v1",
				AUTO_PR_AI_OPENAI_COMPAT_MODEL: "gpt-oss",
			}),
		);
		const layer = Layer.mergeAll(
			TestBaseLayer,
			GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
		);
		const exit = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* GeneratePrContentConfig;
			}).pipe(Effect.provide(layer), Effect.exit),
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

	test("uses default AUTO_PR_AI_OPENAI_COMPAT_URL when not set (local provider)", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				...generatePrContentBaseEnv,
				AUTO_PR_AI_PROVIDER: "local",
				AUTO_PR_AI_OPENAI_COMPAT_MODEL: "gpt-oss",
				// No AUTO_PR_AI_OPENAI_COMPAT_URL
			}),
		);
		const layer = Layer.mergeAll(
			TestBaseLayer,
			GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
		);
		await runEffect(layer)(
			Effect.gen(function* () {
				const config = yield* GeneratePrContentConfig;
				expect(config.provider).toBe("local");
				if (config.provider !== "local") return expect().fail("expected local");
				expect(config.openaiCompatUrl).toBe(DEFAULT_OPENAI_COMPAT_URL);
				expect(config.model).toBe("gpt-oss");
			}),
		);
	});

	test("uses default AUTO_PR_AI_OPENAI_COMPAT_MODEL when not set (local provider)", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				...generatePrContentBaseEnv,
				AUTO_PR_AI_PROVIDER: "local",
				AUTO_PR_AI_OPENAI_COMPAT_URL: "http://localhost:8080/v1",
				// No AUTO_PR_AI_OPENAI_COMPAT_MODEL
			}),
		);
		const layer = Layer.mergeAll(
			TestBaseLayer,
			GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
		);
		await runEffect(layer)(
			Effect.gen(function* () {
				const config = yield* GeneratePrContentConfig;
				expect(config.provider).toBe("local");
				if (config.provider !== "local") return expect().fail("expected local");
				expect(config.model).toBe(DEFAULT_OPENAI_COMPAT_MODEL);
				expect(config.openaiCompatUrl).toBe("http://localhost:8080/v1");
			}),
		);
	});

	test("uses default AUTO_PR_AI_OPENAI_COMPAT_MODEL when not set (github-models provider)", async () => {
		const providerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				...generatePrContentBaseEnv,
				AUTO_PR_AI_PROVIDER: "github-models",
				GH_TOKEN: "ghp_test",
				// No AUTO_PR_AI_OPENAI_COMPAT_MODEL
			}),
		);
		const layer = Layer.mergeAll(
			TestBaseLayer,
			GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
		);
		await runEffect(layer)(
			Effect.gen(function* () {
				const config = yield* GeneratePrContentConfig;
				expect(config.model).toBe(DEFAULT_GITHUB_MODELS_MODEL);
				expect(config.provider).toBe("github-models");
			}),
		);
	});
});
