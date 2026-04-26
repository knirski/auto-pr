import { describe, expect, test } from "bun:test";
import { Cause, Duration, Effect, Exit, Layer, Option, Result, Stream } from "effect";
import { systemError } from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { PullRequestClient } from "#auto-pr";
import { PrLookupError } from "#core/errors.js";
import { runEffect } from "#test/run-effect.js";
import {
	ChildProcessSpawnerCreatePathMock,
	ChildProcessSpawnerTestMock,
	ChildProcessSpawnerUpdatePathMock,
	createTestTempDirEffect,
	SilentLoggerLayer,
	TestBaseLayer,
} from "#test/test-utils.js";
import { runCreateOrUpdatePr } from "#workflow/auto-pr-create-or-update-pr.js";

const TestLayer = Layer.mergeAll(TestBaseLayer, SilentLoggerLayer, ChildProcessSpawnerTestMock);
const UpdatePathLayer = Layer.mergeAll(
	TestBaseLayer,
	SilentLoggerLayer,
	ChildProcessSpawnerUpdatePathMock,
);

describe("runCreateOrUpdatePr", () => {
	test("fails when body file missing", async () => {
		await runEffect(TestLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("create-pr-");
				const exit = yield* runCreateOrUpdatePr({
					branch: "ai/test",
					defaultBranch: "main",
					title: "feat: add x",
					bodyFile: tmp.join("nonexistent.md"),
					workspace: tmp.path,
				}).pipe(Effect.provide(PullRequestClient.Live(tmp.path)), Effect.exit);
				expect(exit._tag).toBe("Failure");
			}).pipe(Effect.scoped),
		);
	});

	test("succeeds when title and body file provided (update path: gh pr edit)", async () => {
		await runEffect(UpdatePathLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("create-pr-");
				const bodyPath = tmp.join("pr-body.md");
				yield* tmp.writeFile(bodyPath, "# PR body\n\nDescription.");

				yield* runCreateOrUpdatePr({
					branch: "ai/test",
					defaultBranch: "main",
					title: "feat: add x",
					bodyFile: bodyPath,
					workspace: tmp.path,
				}).pipe(Effect.provide(PullRequestClient.Live(tmp.path)));
			}).pipe(Effect.scoped),
		);
	});

	test("retries gh create after transient failure", async () => {
		let createCalls = 0;
		const mock = Layer.mock(ChildProcessSpawner)({
			string: (cmd: { _tag: string; command?: string; args?: readonly string[] }) => {
				const args = "args" in cmd ? cmd.args : [];
				if (cmd.command === "gh" && args[1] === "view") {
					return Effect.fail(
						systemError({
							_tag: "NotFound",
							module: "gh",
							method: "pr view",
							description: "no PR found",
						}),
					);
				}
				if (cmd.command === "gh" && args[1] === "create") {
					createCalls += 1;
					if (createCalls === 1) {
						return Effect.fail(
							systemError({
								_tag: "Unknown",
								module: "gh",
								method: "pr create",
								description: "temporary gh failure",
							}),
						);
					}
					return Effect.succeed("https://github.com/owner/repo/pull/99\n");
				}
				return Effect.succeed("");
			},
			streamString: () => Stream.empty,
			streamLines: () => Stream.empty,
		});

		await runEffect(Layer.mergeAll(TestBaseLayer, SilentLoggerLayer, mock))(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("create-pr-retry-");
				const bodyPath = tmp.join("pr-body.md");
				yield* tmp.writeFile(bodyPath, "# PR body\n\nNew feature description.");

				yield* runCreateOrUpdatePr({
					branch: "ai/retry",
					defaultBranch: "main",
					title: "feat: add retry",
					bodyFile: bodyPath,
					workspace: tmp.path,
					retryDelay: Duration.zero,
				}).pipe(Effect.provide(PullRequestClient.Live(tmp.path)));

				expect(createCalls).toBe(2);
			}).pipe(Effect.scoped),
		);
	});

	test("retries PR lookup after transient failure", async () => {
		let viewCalls = 0;
		const mock = Layer.mock(ChildProcessSpawner)({
			string: (cmd: { _tag: string; command?: string; args?: readonly string[] }) => {
				const args = "args" in cmd ? cmd.args : [];
				if (cmd.command === "gh" && args[1] === "view") {
					viewCalls += 1;
					if (viewCalls === 1) {
						return Effect.fail(
							systemError({
								_tag: "Unknown",
								module: "gh",
								method: "pr view",
								description: "temporary gh failure",
							}),
						);
					}
					return Effect.succeed("");
				}
				if (cmd.command === "gh" && args[1] === "create") {
					return Effect.succeed("https://github.com/owner/repo/pull/99\n");
				}
				return Effect.succeed("");
			},
			streamString: () => Stream.empty,
			streamLines: () => Stream.empty,
		});

		await runEffect(Layer.mergeAll(TestBaseLayer, SilentLoggerLayer, mock))(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("create-pr-lookup-retry-");
				const bodyPath = tmp.join("pr-body.md");
				yield* tmp.writeFile(bodyPath, "# PR body\n\nNew feature description.");

				yield* runCreateOrUpdatePr({
					branch: "ai/retry-lookup",
					defaultBranch: "main",
					title: "feat: retry lookup",
					bodyFile: bodyPath,
					workspace: tmp.path,
					retryDelay: Duration.zero,
				}).pipe(Effect.provide(PullRequestClient.Live(tmp.path)));

				expect(viewCalls).toBe(2);
			}).pipe(Effect.scoped),
		);
	});
});

const CreatePathLayer = Layer.mergeAll(
	TestBaseLayer,
	SilentLoggerLayer,
	ChildProcessSpawnerCreatePathMock,
);

describe("PullRequestClient.findByBranch", () => {
	test("returns Option.none when stdout empty", async () => {
		const mock = Layer.mock(ChildProcessSpawner)({
			string: () => Effect.succeed(""),
			streamString: () => Stream.empty,
			streamLines: () => Stream.empty,
		});
		await runEffect(Layer.mergeAll(TestBaseLayer, SilentLoggerLayer, mock))(
			Effect.gen(function* () {
				const client = yield* PullRequestClient;
				const result = yield* client.findByBranch("ai/foo");
				expect(Option.isNone(result)).toBe(true);
			}).pipe(Effect.provide(PullRequestClient.Live("/tmp"))),
		);
	});

	test("returns Option.none when gh reports no PR", async () => {
		const mock = Layer.mock(ChildProcessSpawner)({
			string: () =>
				Effect.fail(
					systemError({
						_tag: "NotFound",
						module: "gh",
						method: "pr view",
						description: "no pull requests found",
					}),
				),
			streamString: () => Stream.empty,
			streamLines: () => Stream.empty,
		});
		await runEffect(Layer.mergeAll(TestBaseLayer, SilentLoggerLayer, mock))(
			Effect.gen(function* () {
				const client = yield* PullRequestClient;
				const result = yield* client.findByBranch("ai/foo");
				expect(Option.isNone(result)).toBe(true);
			}).pipe(Effect.provide(PullRequestClient.Live("/tmp"))),
		);
	});

	test("returns Option.some when gh returns valid JSON", async () => {
		const seenArgs: Array<readonly string[]> = [];
		const mock = Layer.mock(ChildProcessSpawner)({
			string: (cmd: { _tag: string; command?: string; args?: readonly string[] }) => {
				if (cmd.args !== undefined) seenArgs.push(cmd.args);
				return Effect.succeed(
					'{"number":42,"url":"https://github.com/o/r/pull/42","title":"feat: existing"}',
				);
			},
			streamString: () => Stream.empty,
			streamLines: () => Stream.empty,
		});
		await runEffect(Layer.mergeAll(TestBaseLayer, SilentLoggerLayer, mock))(
			Effect.gen(function* () {
				const client = yield* PullRequestClient;
				const result = yield* client.findByBranch("ai/foo");
				expect(Option.isSome(result)).toBe(true);
				if (Option.isSome(result)) {
					expect(result.value.number).toBe(42);
					expect(result.value.url).toBe("https://github.com/o/r/pull/42");
					expect(result.value.title).toBe("feat: existing");
				}
				expect(seenArgs.at(0)).toEqual(["pr", "view", "ai/foo", "--json", "number,url,title"]);
			}).pipe(Effect.provide(PullRequestClient.Live("/tmp"))),
		);
	});

	test("fails with PrLookupError on malformed JSON", async () => {
		const mock = Layer.mock(ChildProcessSpawner)({
			string: () => Effect.succeed("not-json"),
			streamString: () => Stream.empty,
			streamLines: () => Stream.empty,
		});
		const exit = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* PullRequestClient;
				return yield* client.findByBranch("ai/foo");
			}).pipe(
				Effect.provide(PullRequestClient.Live("/tmp")),
				Effect.provide(Layer.mergeAll(TestBaseLayer, SilentLoggerLayer, mock)),
				Effect.exit,
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			Result.match(Cause.findError(exit.cause), {
				onSuccess: (err) => expect(err).toBeInstanceOf(PrLookupError),
				onFailure: () => expect().fail("expected PrLookupError in cause"),
			});
		}
	});

	test("fails with PrLookupError on other gh error", async () => {
		const mock = Layer.mock(ChildProcessSpawner)({
			string: () =>
				Effect.fail(
					systemError({
						_tag: "NotFound",
						module: "gh",
						method: "pr view",
						description: "authentication failed",
					}),
				),
			streamString: () => Stream.empty,
			streamLines: () => Stream.empty,
		});
		const exit = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* PullRequestClient;
				return yield* client.findByBranch("ai/foo");
			}).pipe(
				Effect.provide(PullRequestClient.Live("/tmp")),
				Effect.provide(Layer.mergeAll(TestBaseLayer, SilentLoggerLayer, mock)),
				Effect.exit,
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			Result.match(Cause.findError(exit.cause), {
				onSuccess: (err) => expect(err).toBeInstanceOf(PrLookupError),
				onFailure: () => expect().fail("expected PrLookupError in cause"),
			});
		}
	});

	test("fails with PrLookupError on schema mismatch", async () => {
		const mock = Layer.mock(ChildProcessSpawner)({
			string: () => Effect.succeed('{"wrong":"shape"}'),
			streamString: () => Stream.empty,
			streamLines: () => Stream.empty,
		});
		const exit = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* PullRequestClient;
				return yield* client.findByBranch("ai/foo");
			}).pipe(
				Effect.provide(PullRequestClient.Live("/tmp")),
				Effect.provide(Layer.mergeAll(TestBaseLayer, SilentLoggerLayer, mock)),
				Effect.exit,
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			Result.match(Cause.findError(exit.cause), {
				onSuccess: (err) => expect(err).toBeInstanceOf(PrLookupError),
				onFailure: () => expect().fail("expected PrLookupError in cause"),
			});
		}
	});
});

describe("runCreateOrUpdatePr integration (create path)", () => {
	test("succeeds when body exists and no PR yet (gh pr create path)", async () => {
		await runEffect(CreatePathLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("create-pr-create-");
				const bodyPath = tmp.join("pr-body.md");
				yield* tmp.writeFile(bodyPath, "# PR body\n\nNew feature description.");

				yield* runCreateOrUpdatePr({
					branch: "ai/feature",
					defaultBranch: "main",
					title: "feat: add feature",
					bodyFile: bodyPath,
					workspace: tmp.path,
				}).pipe(Effect.provide(PullRequestClient.Live(tmp.path)));
			}).pipe(Effect.scoped),
		);
	});
});
