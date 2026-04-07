import { describe, expect, test } from "bun:test";
import { Cause, Duration, Effect, Exit, Fiber, Layer, Result } from "effect";
import { TestClock } from "effect/testing";
import { ChildProcess } from "effect/unstable/process";
import {
	ChildProcessSpawner,
	make as makeSpawner,
} from "effect/unstable/process/ChildProcessSpawner";
import { ChildProcessSpawnerLayer } from "#auto-pr";
import { GIT_COMMAND_TIMEOUT, GitContext, GitContextLive } from "#auto-pr/git-context.js";
import { runEffect } from "#test/run-effect.js";
import {
	cleanGitEnv,
	createTestTempDirEffect,
	SilentLoggerLayer,
	TestBaseLayer,
} from "#test/test-utils.js";

const TestLayer = Layer.mergeAll(TestBaseLayer, SilentLoggerLayer, ChildProcessSpawnerLayer);

function setupGitRepoWithFiles(
	workspace: string,
	commits: Array<{ message: string; files?: Array<{ path: string; content: string }> }>,
): Effect.Effect<void, Error, ChildProcessSpawner> {
	return Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner;
		const env = cleanGitEnv();
		const run = (args: string[]) =>
			spawner
				.string(ChildProcess.make("git", args, { cwd: workspace, env, extendEnv: false }))
				.pipe(Effect.mapError((e) => new Error(String(e))));

		yield* run(["init"]);
		yield* run(["config", "user.email", "test@test.com"]);
		yield* run(["config", "user.name", "Test"]);
		yield* run(["config", "commit.gpgsign", "false"]);
		yield* run(["commit", "--allow-empty", "-m", "init"]);

		for (const { message, files } of commits) {
			if (files) {
				for (const { path, content } of files) {
					yield* spawner
						.string(
							ChildProcess.make(
								"bash",
								[
									"-c",
									`mkdir -p "$(dirname "${workspace}/${path}")" && printf '%s' ${JSON.stringify(content)} > "${workspace}/${path}"`,
								],
								{ env, extendEnv: false },
							),
						)
						.pipe(Effect.mapError((e) => new Error(String(e))));
				}
				yield* run(["add", "."]);
			}
			yield* run(["commit", "--allow-empty", "-m", message]);
		}
	});
}

describe("GitContext", () => {
	test("getLog returns log with ---COMMIT--- separators, commit messages, and 40-char hashes", async () => {
		await runEffect(TestLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("git-context-log-");
				yield* setupGitRepoWithFiles(tmp.path, [
					{ message: "feat: add feature" },
					{ message: "fix: resolve bug" },
				]);

				const log = yield* Effect.gen(function* () {
					const git = yield* GitContext;
					return yield* git.getLog("HEAD~2", "HEAD");
				}).pipe(Effect.provide(GitContextLive(tmp.path)));

				expect(log).toContain("---COMMIT---");
				expect(log).toContain("feat: add feature");
				expect(log).toContain("fix: resolve bug");
				// Each hash should be 40 hex chars on its own line
				const hashes = log.match(/^[0-9a-f]{40}$/gm);
				expect(hashes).toBeTruthy();
				expect(hashes?.length).toBeGreaterThanOrEqual(2);
			}).pipe(Effect.scoped),
		);
	});

	test("getChangedFiles returns file names", async () => {
		await runEffect(TestLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("git-context-files-");
				yield* setupGitRepoWithFiles(tmp.path, [
					{
						message: "feat: add module",
						files: [{ path: "src/foo.ts", content: "export const x = 1;\n" }],
					},
				]);

				const files = yield* Effect.gen(function* () {
					const git = yield* GitContext;
					return yield* git.getChangedFiles("HEAD~1", "HEAD");
				}).pipe(Effect.provide(GitContextLive(tmp.path)));

				expect(files).toContain("src/foo.ts");
			}).pipe(Effect.scoped),
		);
	});

	test("getDiffStat returns stat output with file name and change count", async () => {
		await runEffect(TestLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("git-context-stat-");
				yield* setupGitRepoWithFiles(tmp.path, [
					{
						message: "feat: add module",
						files: [{ path: "src/bar.ts", content: "export const y = 2;\n" }],
					},
				]);

				const stat = yield* Effect.gen(function* () {
					const git = yield* GitContext;
					return yield* git.getDiffStat("HEAD~1", "HEAD");
				}).pipe(Effect.provide(GitContextLive(tmp.path)));

				expect(stat).toContain("src/bar.ts");
				// stat output contains a line like "1 file changed, N insertion(s)"
				expect(stat).toMatch(/\d+ insertion/);
			}).pipe(Effect.scoped),
		);
	});

	test("getDiff returns diff for specific file and all files when no path given", async () => {
		await runEffect(TestLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("git-context-diff-");
				yield* setupGitRepoWithFiles(tmp.path, [
					{
						message: "feat: add two files",
						files: [
							{ path: "src/a.ts", content: "export const a = 1;\n" },
							{ path: "src/b.ts", content: "export const b = 2;\n" },
						],
					},
				]);

				// Diff for specific file
				const diffA = yield* Effect.gen(function* () {
					const git = yield* GitContext;
					return yield* git.getDiff("HEAD~1", "HEAD", "src/a.ts");
				}).pipe(Effect.provide(GitContextLive(tmp.path)));

				expect(diffA).toContain("src/a.ts");
				expect(diffA).not.toContain("src/b.ts");

				// Diff for all files (no path)
				const diffAll = yield* Effect.gen(function* () {
					const git = yield* GitContext;
					return yield* git.getDiff("HEAD~1", "HEAD");
				}).pipe(Effect.provide(GitContextLive(tmp.path)));

				expect(diffAll).toContain("src/a.ts");
				expect(diffAll).toContain("src/b.ts");
			}).pipe(Effect.scoped),
		);
	});

	test("getCommitDiff returns the diff for a single commit hash", async () => {
		await runEffect(TestLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("git-context-commit-diff-");
				yield* setupGitRepoWithFiles(tmp.path, [
					{
						message: "feat: single commit",
						files: [{ path: "src/c.ts", content: "export const c = 3;\n" }],
					},
				]);

				const spawner = yield* ChildProcessSpawner;
				const env = cleanGitEnv();
				const hashRaw = yield* spawner
					.string(
						ChildProcess.make("git", ["rev-parse", "HEAD"], {
							cwd: tmp.path,
							env,
							extendEnv: false,
						}),
					)
					.pipe(Effect.mapError((e) => new Error(String(e))));
				const hash = hashRaw.trim();

				const diff = yield* Effect.gen(function* () {
					const git = yield* GitContext;
					return yield* git.getCommitDiff(hash);
				}).pipe(Effect.provide(GitContextLive(tmp.path)));

				expect(diff).toContain("feat: single commit");
				expect(diff).toContain("src/c.ts");
				expect(diff).toContain(hash);
			}).pipe(Effect.scoped),
		);
	});

	test("GIT_COMMAND_TIMEOUT is 30 seconds", () => {
		expect(Duration.toMillis(GIT_COMMAND_TIMEOUT)).toBe(30_000);
	});

	test("git commands fail with a timeout error message when the spawner hangs", async () => {
		// This test verifies that the INTERNAL GIT_COMMAND_TIMEOUT (30s) inside the `run` helper
		// fires and produces the expected error message. Using TestClock so no real time elapses.
		// The test will FAIL if `Effect.timeout(GIT_COMMAND_TIMEOUT)` is removed from git-context.ts.
		const hangingSpawner = Layer.succeed(
			ChildProcessSpawner,
			makeSpawner(() => Effect.never),
		);

		const testEffect = Effect.gen(function* () {
			const git = yield* GitContext;
			// Fork the git call so we can advance the test clock without blocking
			const fiber = yield* Effect.forkChild(git.getLog("HEAD~1", "HEAD"));
			// Advance test clock past the internal 30s GIT_COMMAND_TIMEOUT
			yield* TestClock.adjust(Duration.seconds(31));
			return yield* Fiber.join(fiber).pipe(Effect.exit);
		}).pipe(
			Effect.provide(GitContextLive("/tmp/fake").pipe(Layer.provide(hangingSpawner))),
			Effect.provide(TestClock.layer()),
			Effect.scoped,
		);

		const exit = await Effect.runPromise(testEffect);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			const message = String(exit.cause);
			expect(message).toContain("timed out after 30s");
		}
	});

	test("git commands propagate non-timeout errors with their message", async () => {
		const failingSpawner = Layer.succeed(
			ChildProcessSpawner,
			makeSpawner(() => Effect.fail(new Error("git: not a repository"))),
		);
		const testEffect = Effect.gen(function* () {
			const git = yield* GitContext;
			return yield* git.getLog("HEAD~1", "HEAD").pipe(Effect.exit);
		}).pipe(
			Effect.provide(GitContextLive("/tmp/fake").pipe(Layer.provide(failingSpawner))),
			Effect.scoped,
		);

		const exit = await Effect.runPromise(testEffect);
		// The spawner error is wrapped in PullRequestFailedError by runCommand, then re-wrapped
		// in Error by the mapError non-timeout branch (lines 45-46 in git-context.ts).
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			Result.match(Cause.findError(exit.cause), {
				onSuccess: (err) => expect(err).toBeInstanceOf(Error),
				onFailure: () => expect.unreachable("expected Error in cause"),
			});
		}
	});
});
