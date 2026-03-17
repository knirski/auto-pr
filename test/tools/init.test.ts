import { describe, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "#test/run-effect.js";
import { createTestTempDirEffect, TestBaseLayer } from "#test/test-utils.js";
import { runInit } from "#tools/auto-pr-init.js";

describe("runInit", () => {
	test("creates workflow, PR template, and .nvmrc in target directory", async () => {
		await runEffect(
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

				const workflowContent = yield* fs.readFileString(
					tmp.join(".github", "workflows", "auto-pr.yml"),
				);
				expect(workflowContent).toContain("jobs:");
				expect(workflowContent).toContain("on:");

				const nvmrcContent = yield* fs.readFileString(tmp.join(".nvmrc"));
				expect(nvmrcContent.trim()).toMatch(/^\d+$/);
			}).pipe(Effect.scoped),
			TestBaseLayer,
		);
	});

	test("skips existing files on second run", async () => {
		await runEffect(
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
			TestBaseLayer,
		);
	});
});
