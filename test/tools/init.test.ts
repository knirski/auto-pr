import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { createTestTempDirEffect, TestBaseLayer } from "#test/test-utils.js";
import { runInit } from "#tools/init.js";

layer(TestBaseLayer)("runInit", (it) => {
	it.effect("creates workflow, PR template, and .nvmrc in target directory", () =>
		Effect.gen(function* () {
			const tmp = yield* createTestTempDirEffect("auto-pr-init-");

			yield* runInit(tmp.path);

			const fs = yield* FileSystem.FileSystem;
			const [workflowExists, templateExists, nvmrcExists] = yield* Effect.all([
				fs.exists(tmp.join(".github", "workflows", "auto-pr.yml")),
				fs.exists(tmp.join(".github", "PULL_REQUEST_TEMPLATE.md")),
				fs.exists(tmp.join(".nvmrc")),
			]);

			expect(workflowExists).toBe(true);
			expect(templateExists).toBe(true);
			expect(nvmrcExists).toBe(true);

			// Verify workflow structure
			const workflowContent = yield* fs.readFileString(
				tmp.join(".github", "workflows", "auto-pr.yml"),
			);
			expect(workflowContent).toContain("jobs:");
			expect(workflowContent).toContain("on:");

			// Verify .nvmrc content
			const nvmrcContent = yield* fs.readFileString(tmp.join(".nvmrc"));
			expect(nvmrcContent.trim()).toMatch(/^\d+$/);
		}).pipe(Effect.scoped),
	);

	it.effect("skips existing files on second run", () =>
		Effect.gen(function* () {
			const tmp = yield* createTestTempDirEffect("auto-pr-init-skip-");

			yield* runInit(tmp.path);
			const workflowPath = tmp.join(".github", "workflows", "auto-pr.yml");
			const fs = yield* FileSystem.FileSystem;
			const contentAfterFirst = yield* fs.readFileString(workflowPath);

			yield* runInit(tmp.path);
			const contentAfterSecond = yield* fs.readFileString(workflowPath);

			expect(contentAfterSecond).toBe(contentAfterFirst);
		}).pipe(Effect.scoped),
	);
});
