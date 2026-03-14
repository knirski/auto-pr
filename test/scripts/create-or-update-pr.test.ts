import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { runCreateOrUpdatePr } from "../../scripts/create-or-update-pr.js";
import {
	ChildProcessSpawnerTestMock,
	createTestTempDirEffect,
	SilentLoggerLayer,
	TestBaseLayer,
} from "../test-utils.js";

const TestLayer = Layer.mergeAll(TestBaseLayer, SilentLoggerLayer, ChildProcessSpawnerTestMock);

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

	it.effect("succeeds when title and body file provided", () =>
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
	);
});
