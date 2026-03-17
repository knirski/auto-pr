import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Exit, Layer, Redacted } from "effect";
import {
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
import { TestBaseLayer } from "#test/test-utils.js";

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
		await runEffect(
			Effect.gen(function* () {
				const config = yield* GetCommitsConfig;
				expect(config.defaultBranch).toBe("main");
				expect(config.workspace).toBe("/workspace");
				expect(config.ghOutput).toBe("/tmp/gh-output");
			}),
			GetCommitsLayer,
		);
	});
});

const GeneratePrContentConfigProviderLayer = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		COMMITS: "/c/commits.txt",
		FILES: "/c/files.txt",
		GITHUB_OUTPUT: "/tmp/gh-output",
		GITHUB_WORKSPACE: "/workspace",
		PR_TEMPLATE_PATH: "/t/template.md",
		OLLAMA_MODEL: "llama3.1:8b",
		OLLAMA_URL: "http://localhost:11434/api/generate",
		AUTO_PR_HOW_TO_TEST: "1. Run tests",
	}),
);

const GeneratePrContentLayer = Layer.mergeAll(
	TestBaseLayer,
	GeneratePrContentConfigLayer.pipe(Layer.provide(GeneratePrContentConfigProviderLayer)),
);

describe("GeneratePrContentConfigLayer succeeds when all vars present", () => {
	test("returns config with non-empty values", async () => {
		await runEffect(
			Effect.gen(function* () {
				const config = yield* GeneratePrContentConfig;
				expect(config.commits).toBe("/c/commits.txt");
				expect(config.files).toBe("/c/files.txt");
				expect(config.templatePath).toBe("/t/template.md");
				expect(config.model).toBe("llama3.1:8b");
				expect(config.howToTestDefault).toBe("1. Run tests");
			}),
			GeneratePrContentLayer,
		);
	});
});

const CreateOrUpdatePrConfigProviderLayer = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		BRANCH: "ai/feature",
		DEFAULT_BRANCH: "main",
		TITLE: "feat: add x",
		BODY_FILE: "/tmp/body.md",
		GITHUB_WORKSPACE: "/workspace",
		GH_TOKEN: "ghp_test_token",
	}),
);

const CreateOrUpdatePrLayer = Layer.mergeAll(
	TestBaseLayer,
	CreateOrUpdatePrConfigLayer.pipe(Layer.provide(CreateOrUpdatePrConfigProviderLayer)),
);

describe("CreateOrUpdatePrConfigLayer succeeds when all vars present", () => {
	test("returns config with ghToken redacted", async () => {
		await runEffect(
			Effect.gen(function* () {
				const config = yield* CreateOrUpdatePrConfig;
				expect(config.branch).toBe("ai/feature");
				expect(config.title).toBe("feat: add x");
				expect(config.bodyFile).toBe("/tmp/body.md");
				expect(Redacted.isRedacted(config.ghToken)).toBe(true);
			}),
			CreateOrUpdatePrLayer,
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

	test("GeneratePrContentConfigLayer fails when COMMITS/FILES/GITHUB_OUTPUT missing", async () => {
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
				CreateOrUpdatePrConfigLayer,
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
