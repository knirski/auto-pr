/**
 * Integration tests for the full auto-PR pipeline: get-commits → generate-pr-content.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { ChildProcessSpawnerLayer, FillPrTemplate, parseGhOutput } from "#auto-pr";
import { runEffect } from "#test/run-effect.js";
import {
	createOpenAiChatCompletionsMockFetch,
	createTestTempDirEffect,
	SilentLoggerLayer,
	TestBaseLayer,
} from "#test/test-utils.js";
import { runGeneratePrContent } from "#workflow/auto-pr-generate-content.js";
import { runAutoPrGetCommits } from "#workflow/auto-pr-get-commits.js";

const TestLayer = Layer.mergeAll(
	TestBaseLayer,
	SilentLoggerLayer,
	ChildProcessSpawnerLayer,
	FillPrTemplate.Live,
);

function setupGitRepo(
	workspace: string,
	commits: Array<{ message: string }>,
): Effect.Effect<void, Error, ChildProcessSpawner> {
	return Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner;
		const run = (args: string[]) =>
			spawner
				.string(ChildProcess.make("git", args, { cwd: workspace }))
				.pipe(Effect.mapError((e) => new Error(String(e))));

		yield* run(["init"]);
		yield* run(["config", "user.email", "test@test.com"]);
		yield* run(["config", "user.name", "Test"]);
		yield* run(["config", "init.defaultBranch", "main"]);
		yield* run(["commit", "--allow-empty", "-m", "init"]);
		for (const { message } of commits) {
			yield* run(["commit", "--allow-empty", "-m", message]);
		}
		const n = commits.length;
		yield* run(["update-ref", "refs/remotes/origin/main", `HEAD~${n}`]);
	});
}

describe("get-commits → generate-pr-content pipeline", () => {
	test("handoff: GITHUB_OUTPUT from get-commits feeds generate-pr-content", async () => {
		await runEffect(TestLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("pipeline-");
				const fs = yield* FileSystem.FileSystem;
				const pathApi = yield* Path.Path;

				yield* setupGitRepo(tmp.path, [{ message: "feat: add feature" }]);

				const ghOutput = pathApi.join(tmp.path, "github_output.txt");
				yield* runAutoPrGetCommits("main", tmp.path, ghOutput);

				const ghAfterGetCommits = yield* fs.readFileString(ghOutput);
				const parsed = parseGhOutput(ghAfterGetCommits);
				expect(parsed.commits).toBe(join(tmp.path, "commits.txt"));
				expect(parsed.files).toBe(join(tmp.path, "files.txt"));

				const templatePath = pathApi.join(tmp.path, "template.md");
				yield* fs.writeFileString(templatePath, "# PR\n\n{{description}}\n\n{{changes}}");

				yield* runGeneratePrContent({
					commits: join(tmp.path, "commits.txt"),
					files: join(tmp.path, "files.txt"),
					workspace: tmp.path,
					templatePath,
					provider: "local",
					model: "gpt-oss",
					fetch: createOpenAiChatCompletionsMockFetch(""),
				});

				const ghAfterGenerate = yield* fs.readFileString(ghOutput);
				expect(ghAfterGenerate).toContain("commits=");
				expect(ghAfterGenerate).toContain("files=");
				expect(ghAfterGenerate).toContain("count=1");

				const titleContent = yield* fs.readFileString(pathApi.join(tmp.path, "pr-title.txt"));
				expect(titleContent).toContain("feat: add feature");

				const bodyPath = pathApi.join(tmp.path, "pr-body.md");
				const bodyContent = yield* fs.readFileString(bodyPath);
				expect(bodyContent).toContain("feat: add feature");
			}).pipe(Effect.scoped),
		);
	});
});
