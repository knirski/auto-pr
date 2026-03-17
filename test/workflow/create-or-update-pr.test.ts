import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
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
		await runEffect(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("create-pr-");
				const exit = yield* runCreateOrUpdatePr({
					branch: "ai/test",
					defaultBranch: "main",
					title: "feat: add x",
					bodyFile: tmp.join("nonexistent.md"),
					workspace: tmp.path,
				}).pipe(Effect.exit);
				expect(exit._tag).toBe("Failure");
			}).pipe(Effect.scoped),
			TestLayer,
		);
	});

	test("succeeds when title and body file provided (update path: gh pr edit)", async () => {
		await runEffect(
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
				});
			}).pipe(Effect.scoped),
			UpdatePathLayer,
		);
	});
});

const CreatePathLayer = Layer.mergeAll(
	TestBaseLayer,
	SilentLoggerLayer,
	ChildProcessSpawnerCreatePathMock,
);

describe("runCreateOrUpdatePr integration (create path)", () => {
	test("succeeds when body exists and no PR yet (gh pr create path)", async () => {
		await runEffect(
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
				});
			}).pipe(Effect.scoped),
			CreatePathLayer,
		);
	});
});
