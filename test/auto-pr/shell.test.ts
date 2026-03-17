import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Layer } from "effect";
import { appendGhOutput, ChildProcessSpawnerLayer, getDebugHint, runCommand } from "#auto-pr";
import { runEffect } from "#test/run-effect.js";
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

describe("runCommand", () => {
	test("maps command failure to PullRequestFailedError", async () => {
		const layer = Layer.mergeAll(TestBaseLayer, ChildProcessSpawnerLayer);
		const exit = await runEffect(
			runCommand("nonexistentcommandxyz123", [], process.cwd()).pipe(Effect.exit, Effect.scoped),
			layer,
		);
		expect(exit._tag).toBe("Failure");
		if (exit._tag === "Failure") {
			expect(String(exit.cause)).toContain("PullRequestFailedError");
		}
	});
});

describe("appendGhOutput", () => {
	test("writes entries to file", async () => {
		await runEffect(
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
			TestBaseLayer,
		);
	});

	test("appends to existing file", async () => {
		await runEffect(
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
			TestBaseLayer,
		);
	});
});
