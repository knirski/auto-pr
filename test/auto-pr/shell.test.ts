import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { describe, test } from "vitest";
import { appendGhOutput, getDebugHint } from "#auto-pr";
import { createTestTempDirEffect, TestBaseLayer } from "#test/test-utils.js";

describe("getDebugHint", () => {
	test("returns empty when AUTO_PR_DEBUG=1", () => {
		const orig = process.env.AUTO_PR_DEBUG;
		process.env.AUTO_PR_DEBUG = "1";
		try {
			expect(getDebugHint()).toBe("");
		} finally {
			process.env.AUTO_PR_DEBUG = orig;
		}
	});

	test("returns empty when AUTO_PR_DEBUG=true", () => {
		const orig = process.env.AUTO_PR_DEBUG;
		process.env.AUTO_PR_DEBUG = "true";
		try {
			expect(getDebugHint()).toBe("");
		} finally {
			process.env.AUTO_PR_DEBUG = orig;
		}
	});

	test("returns hint when AUTO_PR_DEBUG not set", () => {
		const orig = process.env.AUTO_PR_DEBUG;
		delete process.env.AUTO_PR_DEBUG;
		try {
			expect(getDebugHint()).toBe(" Set AUTO_PR_DEBUG=1 for verbose output.");
		} finally {
			process.env.AUTO_PR_DEBUG = orig;
		}
	});
});

layer(TestBaseLayer)("appendGhOutput", (it) => {
	it.effect("writes entries to file", () =>
		Effect.gen(function* () {
			const tmp = yield* createTestTempDirEffect("auto-pr-shell-");
			const path = tmp.join("github_output.txt");

			yield* appendGhOutput(path, [
				{ key: "a", value: "1" },
				{ key: "b", value: "2" },
			]);

			const fs = yield* FileSystem.FileSystem;
			const content = yield* fs.readFileString(path);
			expect(content).toContain("a=1");
			expect(content).toContain("b=2");
		}).pipe(Effect.scoped),
	);

	it.effect("appends to existing file", () =>
		Effect.gen(function* () {
			const tmp = yield* createTestTempDirEffect("auto-pr-shell-");
			const path = tmp.join("github_output.txt");
			const fs = yield* FileSystem.FileSystem;
			yield* fs.writeFileString(path, "existing=line\n");

			yield* appendGhOutput(path, [{ key: "new", value: "value" }]);

			const content = yield* fs.readFileString(path);
			expect(content).toContain("existing=line");
			expect(content).toContain("new=value");
		}).pipe(Effect.scoped),
	);
});
