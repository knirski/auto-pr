import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
	ChildProcessSpawnerCreatePathMock,
	ChildProcessSpawnerTestMock,
	ChildProcessSpawnerUpdatePathMock,
	createTestTempDirEffect,
	SilentLoggerLayer,
	TestBaseLayer,
} from "#test/test-utils.js";
import { runCreateOrUpdatePr } from "#workflow/create-or-update-pr.js";

const TestLayer = Layer.mergeAll(TestBaseLayer, SilentLoggerLayer, ChildProcessSpawnerTestMock);
const UpdatePathLayer = Layer.mergeAll(
	TestBaseLayer,
	SilentLoggerLayer,
	ChildProcessSpawnerUpdatePathMock,
);

layer(TestLayer)("runCreateOrUpdatePr", (it) => {
	it.effect("fails when body file missing", () =>
		Effect.gen(function* () {
			const tmp = yield* createTestTempDirEffect("create-pr-");
			// bodyFile points to non-existent file; gh will fail
			const exit = yield* runCreateOrUpdatePr({
				branch: "ai/test",
				defaultBranch: "main",
				title: "feat: add x",
				bodyFile: tmp.join("nonexistent.md"),
				workspace: tmp.path,
			}).pipe(Effect.exit);
			expect(exit._tag).toBe("Failure");
		}).pipe(Effect.scoped),
	);

	it.effect("succeeds when title and body file provided (update path: gh pr edit)", () =>
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
		}).pipe(Effect.provide(UpdatePathLayer)),
	);
});

const CreatePathLayer = Layer.mergeAll(
	TestBaseLayer,
	SilentLoggerLayer,
	ChildProcessSpawnerCreatePathMock,
);

layer(CreatePathLayer)("runCreateOrUpdatePr integration (create path)", (it) => {
	it.effect("succeeds when body exists and no PR yet (gh pr create path)", () =>
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
	);
});
