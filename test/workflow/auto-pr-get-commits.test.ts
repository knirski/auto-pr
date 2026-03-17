import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { ChildProcessSpawnerLayer } from "#auto-pr";
import { runEffect } from "#test/run-effect.js";
import { createTestTempDirEffect, SilentLoggerLayer, TestBaseLayer } from "#test/test-utils.js";
import { runAutoPrGetCommits } from "#workflow/auto-pr-get-commits.js";

const TestLayer = Layer.mergeAll(TestBaseLayer, SilentLoggerLayer, ChildProcessSpawnerLayer);

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

function setupGitRepoWithFiles(
	workspace: string,
	commits: Array<{ message: string; files?: Array<{ path: string; content: string }> }>,
): Effect.Effect<void, Error, ChildProcessSpawner | FileSystem.FileSystem | Path.Path> {
	return Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner;
		const fs = yield* FileSystem.FileSystem;
		const run = (args: string[]) =>
			spawner
				.string(ChildProcess.make("git", args, { cwd: workspace }))
				.pipe(Effect.mapError((e) => new Error(String(e))));

		yield* run(["init"]);
		yield* run(["config", "user.email", "test@test.com"]);
		yield* run(["config", "user.name", "Test"]);
		yield* run(["config", "init.defaultBranch", "main"]);
		yield* run(["commit", "--allow-empty", "-m", "init"]);
		const pathApi = yield* Path.Path;
		for (const { message, files } of commits) {
			if (files) {
				for (const { path, content } of files) {
					const fullPath = pathApi.join(workspace, path);
					const dir = pathApi.dirname(fullPath);
					yield* fs.makeDirectory(dir, { recursive: true });
					yield* fs.writeFileString(fullPath, content);
				}
				yield* run(["add", "."]);
			}
			yield* run(["commit", "-m", message]);
		}
		const n = commits.length;
		yield* run(["update-ref", "refs/remotes/origin/main", `HEAD~${n}`]);
	});
}

describe("runAutoPrGetCommits", () => {
	test("writes output files and GITHUB_OUTPUT for single semantic commit", async () => {
		await runEffect(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("auto-pr-get-commits-");
				yield* setupGitRepo(tmp.path, [{ message: "feat: add feature" }]);

				const ghOutput = tmp.join("github_output.txt");
				yield* runAutoPrGetCommits("main", tmp.path, ghOutput);

				const fs = yield* FileSystem.FileSystem;
				const content = yield* fs.readFileString(ghOutput);
				expect(content).toContain("commits=");
				expect(content).toContain("files=");
				expect(content).toContain("count=1");

				const commitsPath = tmp.join("commits.txt");
				const commitsContent = yield* fs.readFileString(commitsPath);
				expect(commitsContent).toContain("feat: add feature");
			}).pipe(Effect.scoped),
			TestLayer,
		);
	});

	test("writes correct count and files for multiple semantic commits", async () => {
		await runEffect(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("auto-pr-get-commits-multi-");
				yield* setupGitRepo(tmp.path, [{ message: "feat: add x" }, { message: "fix: resolve y" }]);

				const ghOutput = tmp.join("github_output.txt");
				yield* runAutoPrGetCommits("main", tmp.path, ghOutput);

				const fs = yield* FileSystem.FileSystem;
				const ghContent = yield* fs.readFileString(ghOutput);
				expect(ghContent).toContain("count=2");

				const subjectsContent = yield* fs.readFileString(tmp.join("subjects.txt"));
				expect(subjectsContent).toContain("feat: add x");
				expect(subjectsContent).toContain("fix: resolve y");

				const semanticContent = yield* fs.readFileString(tmp.join("semantic_subjects.txt"));
				expect(semanticContent).toContain("feat: add x");
				expect(semanticContent).toContain("fix: resolve y");
			}).pipe(Effect.scoped),
			TestLayer,
		);
	});

	test("fails when no semantic commits", async () => {
		await runEffect(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("auto-pr-get-commits-empty-");
				yield* setupGitRepo(tmp.path, [{ message: "Merge branch 'x'" }]);

				const exit = yield* runAutoPrGetCommits("main", tmp.path, tmp.join("out.txt")).pipe(
					Effect.exit,
				);

				expect(exit._tag).toBe("Failure");
			}).pipe(Effect.scoped),
			TestLayer,
		);
	});

	test("writes files.txt with changed file paths when commits touch files", async () => {
		await runEffect(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("auto-pr-get-commits-files-");
				yield* setupGitRepoWithFiles(tmp.path, [
					{
						message: "feat: add module",
						files: [
							{ path: "src/foo.ts", content: "export const x = 1;\n" },
							{ path: "README.md", content: "# Project\n" },
						],
					},
				]);

				const ghOutput = tmp.join("github_output.txt");
				yield* runAutoPrGetCommits("main", tmp.path, ghOutput);

				const fs = yield* FileSystem.FileSystem;
				const filesContent = yield* fs.readFileString(tmp.join("files.txt"));
				expect(filesContent).toContain("src/foo.ts");
				expect(filesContent).toContain("README.md");

				const ghContent = yield* fs.readFileString(ghOutput);
				expect(ghContent).toContain("count=1");
			}).pipe(Effect.scoped),
			TestLayer,
		);
	});
});
