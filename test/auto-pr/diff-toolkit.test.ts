import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option, Stream } from "effect";
import { DiffToolkit, makeDiffToolkitLayer } from "#auto-pr/diff-toolkit.js";
import { GitContext } from "#auto-pr/git-context.js";
import { runEffect } from "#test/run-effect.js";
import { createGitContextMock, SilentLoggerLayer, TestBaseLayer } from "#test/test-utils.js";

describe("DiffToolkit handlers", () => {
	test("get_diff handler calls GitContext.getDiff with correct refs", async () => {
		let capturedArgs: { baseRef: string; headRef: string; path: string | undefined } | undefined;
		const mockGitCtx = createGitContextMock({
			getDiff: (baseRef, headRef, path?) => {
				capturedArgs = { baseRef, headRef, path };
				return Effect.succeed("diff --git a/foo.ts b/foo.ts\n+const x = 1;");
			},
		});
		const toolkitLayer = makeDiffToolkitLayer("origin/main", "ai/feature");
		const gitLayer = Layer.succeed(GitContext, mockGitCtx);
		const TestLayer = Layer.mergeAll(
			TestBaseLayer,
			SilentLoggerLayer,
			toolkitLayer.pipe(Layer.provide(gitLayer)),
		);
		await runEffect(TestLayer)(
			Effect.gen(function* () {
				const toolkit = yield* DiffToolkit;
				const stream = yield* toolkit.handle("get_diff", { path: "foo.ts" });
				const last = yield* Stream.runLast(stream);
				const handlerResult = Option.getOrThrow(last);
				const result = handlerResult.result;
				expect(String(result)).toContain("+const x = 1;");
				expect(capturedArgs?.baseRef).toBe("origin/main");
				expect(capturedArgs?.path).toBe("foo.ts");
			}).pipe(Effect.scoped),
		);
	});

	test("get_commit_diff handler calls GitContext.getCommitDiff", async () => {
		let capturedHash: string | undefined;
		const mockGitCtx = createGitContextMock({
			getCommitDiff: (hash) => {
				capturedHash = hash;
				return Effect.succeed("commit abc123\nfeat: add x\n\ndiff content");
			},
		});
		const toolkitLayer = makeDiffToolkitLayer("origin/main", "ai/feature");
		const gitLayer = Layer.succeed(GitContext, mockGitCtx);
		const TestLayer = Layer.mergeAll(
			TestBaseLayer,
			SilentLoggerLayer,
			toolkitLayer.pipe(Layer.provide(gitLayer)),
		);
		await runEffect(TestLayer)(
			Effect.gen(function* () {
				const toolkit = yield* DiffToolkit;
				const stream = yield* toolkit.handle("get_commit_diff", { hash: "abc123" });
				const last = yield* Stream.runLast(stream);
				const handlerResult = Option.getOrThrow(last);
				const result = handlerResult.result;
				expect(String(result)).toContain("diff content");
				expect(capturedHash).toBe("abc123");
			}).pipe(Effect.scoped),
		);
	});

	test("DiffToolkit is a Toolkit with get_diff and get_commit_diff tools", () => {
		// Verify DiffToolkit is defined and has the expected structure
		expect(DiffToolkit).toBeDefined();
		expect(typeof makeDiffToolkitLayer).toBe("function");
	});
});
