import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Option, Redacted } from "effect";
import { aiProviderLayerFromConfig, DiffToolkit, PullRequestClient } from "#auto-pr";
import { GitContext } from "#auto-pr/git-context.js";
import { runEffect } from "#test/run-effect.js";
import {
	ChildProcessSpawnerTestMock,
	createGitContextMock,
	createTestTempDirEffect,
	TestBaseLayer,
} from "#test/test-utils.js";
import {
	generateContentConfigFromRunAutoPrConfig,
	prTitleReadError,
	runAutoPrPipelineWithServices,
} from "#workflow/auto-pr-run-pipeline.js";

function logContent(...subjects: readonly string[]): string {
	return `---COMMIT---\n${subjects
		.map((subject) => `0000000000000000000000000000000000000000\n${subject}`)
		.join("\n---COMMIT---\n")}`;
}

describe("runAutoPrPipelineWithServices", () => {
	test("formats pr-title read failures", () => {
		expect(prTitleReadError(new Error("missing")).cause).toBe("pr-title.txt: missing");
	});

	test("maps local run config to generate-content service config", () => {
		const ghToken = Redacted.make("ghp_test");
		const config = generateContentConfigFromRunAutoPrConfig(
			{
				provider: "local",
				defaultBranch: "main",
				workspace: "/workspace",
				templatePath: "/workspace/.github/PULL_REQUEST_TEMPLATE.md",
				model: "gpt-oss",
				ghToken,
				openaiCompatUrl: "http://127.0.0.1:8080/v1",
				openaiCompatApiKey: Redacted.make("sk-test"),
				existingPrTitle: "feat: existing title",
			},
			"ai/example",
		);

		expect(config).toEqual({
			provider: "local",
			defaultBranch: "main",
			branch: "ai/example",
			workspace: "/workspace",
			templatePath: "/workspace/.github/PULL_REQUEST_TEMPLATE.md",
			model: "gpt-oss",
			existingPrTitle: "feat: existing title",
		});
	});

	test("maps github-models run config to generate-content service config", () => {
		const ghToken = Redacted.make("ghp_test");
		const config = generateContentConfigFromRunAutoPrConfig(
			{
				provider: "github-models",
				defaultBranch: "main",
				workspace: "/workspace",
				templatePath: "/workspace/.github/PULL_REQUEST_TEMPLATE.md",
				model: "openai/gpt-4.1",
				ghToken,
				aiTokenBudget: 9000,
				aiToolRoundLimit: 4,
				aiToolResponseCharBudget: 1500,
			},
			"ai/example",
		);

		expect(config).toEqual({
			provider: "github-models",
			defaultBranch: "main",
			branch: "ai/example",
			workspace: "/workspace",
			templatePath: "/workspace/.github/PULL_REQUEST_TEMPLATE.md",
			model: "openai/gpt-4.1",
			aiTokenBudget: 9000,
			aiToolRoundLimit: 4,
			aiToolResponseCharBudget: 1500,
			aiLimitsSource: "routing_decision",
		});
	});

	test("resolves branch via injected GitContext and creates PR via injected PullRequestClient", async () => {
		const calls: Array<{
			readonly headBranch: string;
			readonly baseBranch: string;
			readonly title: string;
			readonly bodyPath: string;
		}> = [];
		const git = createGitContextMock({
			getCurrentBranch: () => Effect.succeed("ai/from-git"),
			getLog: () => Effect.succeed(logContent("feat: add local runner")),
			getChangedFiles: () => Effect.succeed("src/workflow/auto-pr-run.ts\n"),
			getDiffStat: () => Effect.succeed(" src/workflow/auto-pr-run.ts | 1 +\n"),
		});
		const prClient = PullRequestClient.of({
			findByBranch: () => Effect.succeed(Option.none()),
			update: () => Effect.void,
			create: (headBranch, baseBranch, title, bodyPath) => {
				calls.push({ headBranch, baseBranch, title, bodyPath });
				return Effect.succeed("https://github.com/knirski/auto-pr/pull/1");
			},
		});

		await runEffect(
			Layer.mergeAll(
				TestBaseLayer,
				ChildProcessSpawnerTestMock,
				Layer.succeed(GitContext, git),
				Layer.succeed(PullRequestClient, prClient),
				DiffToolkit.toLayer(
					Effect.succeed(
						DiffToolkit.of({
							get_diff: () => Effect.succeed(""),
							get_commit_diff: () => Effect.succeed(""),
						}),
					),
				),
				aiProviderLayerFromConfig({
					provider: "local",
					model: "gpt-oss",
				}),
			),
		)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("run-auto-pr-");
				try {
					const fs = yield* FileSystem.FileSystem;
					yield* fs.makeDirectory(tmp.join(".github"), { recursive: true });
					yield* fs.writeFileString(
						tmp.join(".github/PULL_REQUEST_TEMPLATE.md"),
						"# PR\n\n{{description}}",
					);

					yield* runAutoPrPipelineWithServices({
						defaultBranch: "main",
						workspace: tmp.path,
						templatePath: tmp.join(".github/PULL_REQUEST_TEMPLATE.md"),
						ghToken: Redacted.make("ghp_test"),
						provider: "local",
						model: "gpt-oss",
						openaiCompatUrl: "http://127.0.0.1:8080/v1",
					});

					expect(calls).toEqual([
						{
							headBranch: "ai/from-git",
							baseBranch: "main",
							title: "feat: add local runner",
							bodyPath: tmp.join("pr-body.md"),
						},
					]);
					expect((yield* fs.readFileString(tmp.join("pr-title.txt"))).trim()).toBe(
						"feat: add local runner",
					);
				} finally {
					yield* tmp.remove();
				}
			}).pipe(Effect.scoped),
		);
	});
});
