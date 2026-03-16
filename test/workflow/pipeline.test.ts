/**
 * Integration tests for the full auto-PR pipeline: get-commits → generate-pr-content.
 * Verifies workflows work together (append to GITHUB_OUTPUT, path handoff).
 */
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import * as Http from "effect/unstable/http";
import { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { ChildProcessSpawnerLayer, FillPrTemplate, parseGhOutput } from "#auto-pr";
import { createTestTempDirEffect, SilentLoggerLayer, TestBaseLayer } from "#test/test-utils.js";
import { runAutoPrGetCommits } from "#workflow/auto-pr-get-commits.js";
import { runGeneratePrContent } from "#workflow/generate-pr-content.js";

const TestLayer = Layer.mergeAll(
	TestBaseLayer,
	SilentLoggerLayer,
	ChildProcessSpawnerLayer,
	FillPrTemplate.Live,
	Http.FetchHttpClient.layer,
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

layer(TestLayer)("get-commits → generate-pr-content pipeline", (it) => {
	it.effect("handoff: GITHUB_OUTPUT from get-commits feeds generate-pr-content", () =>
		Effect.gen(function* () {
			const tmp = yield* createTestTempDirEffect("pipeline-");
			const fs = yield* FileSystem.FileSystem;
			const pathApi = yield* Path.Path;

			yield* setupGitRepo(tmp.path, [{ message: "feat: add feature" }]);

			const ghOutput = pathApi.join(tmp.path, "github_output.txt");
			yield* runAutoPrGetCommits("main", tmp.path, ghOutput);

			const ghAfterGetCommits = yield* fs.readFileString(ghOutput);
			const parsed = parseGhOutput(ghAfterGetCommits);
			const commitsPath = parsed.commits;
			const filesPath = parsed.files;
			expect(commitsPath).toBeDefined();
			expect(filesPath).toBeDefined();

			const templatePath = pathApi.join(tmp.path, "template.md");
			yield* fs.writeFileString(templatePath, "# PR\n\n{{description}}\n\n{{changes}}");

			yield* runGeneratePrContent({
				commits: commitsPath ?? "",
				files: filesPath ?? "",
				ghOutput,
				workspace: tmp.path,
				templatePath,
				model: "llama3.1:8b",
				ollamaUrl: "http://localhost:11434/api/generate",
				howToTestDefault: "1. Run `npm run check`\n2. ",
			});

			const ghAfterGenerate = yield* fs.readFileString(ghOutput);
			expect(ghAfterGenerate).toContain("commits=");
			expect(ghAfterGenerate).toContain("files=");
			expect(ghAfterGenerate).toContain("count=1");
			expect(ghAfterGenerate).toContain("title=");
			expect(ghAfterGenerate).toContain("body_file=");

			const bodyPath = pathApi.join(tmp.path, "pr-body.md");
			const bodyContent = yield* fs.readFileString(bodyPath);
			expect(bodyContent).toContain("feat: add feature");
		}).pipe(Effect.scoped),
	);
});
