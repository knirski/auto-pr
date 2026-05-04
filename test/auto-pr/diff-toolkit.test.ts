import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option, Stream } from "effect";
import { DiffToolkit, makeDiffToolkitLayer } from "#auto-pr/diff-toolkit.js";
import { GitContext } from "#auto-pr/git-context.js";
import { MAX_AI_TOOL_ROUNDTRIP_DIFF_CHARS } from "#core/sanitize-diff.js";
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

	test("get_diff handler treats null path like an omitted path", async () => {
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
				const stream = yield* toolkit.handle("get_diff", { path: null as never });
				const last = yield* Stream.runLast(stream);
				const handlerResult = Option.getOrThrow(last);
				const result = handlerResult.result;
				expect(String(result)).toContain("+const x = 1;");
				expect(capturedArgs?.baseRef).toBe("origin/main");
				expect(capturedArgs?.path).toBeUndefined();
			}).pipe(Effect.scoped),
		);
	});

	test("get_diff handler keeps non-null invalid path as a schema error", async () => {
		const mockGitCtx = createGitContextMock({
			getDiff: () => Effect.succeed("diff --git a/foo.ts b/foo.ts\n+const x = 1;"),
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
				const exit = yield* toolkit.handle("get_diff", { path: 123 as never }).pipe(Effect.exit);
				expect(exit._tag).toBe("Failure");
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

describe("DiffToolkit error responses", () => {
	test("get_diff handler returns [TOOL_ERROR] prefixed message on error", async () => {
		const mockGitCtx = createGitContextMock({
			getDiff: () => Effect.fail(new Error("git failed: no such ref")),
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
				const result = String(handlerResult.result);
				expect(result).toContain("[TOOL_ERROR]");
				expect(result).toContain("get_diff failed");
				expect(result).toContain("git failed: no such ref");
				expect(result).toContain("No diff available for this request.");
			}).pipe(Effect.scoped),
		);
	});

	test("get_commit_diff handler returns [TOOL_ERROR] prefixed message on error", async () => {
		const mockGitCtx = createGitContextMock({
			getCommitDiff: () => Effect.fail(new Error("unknown commit")),
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
				const result = String(handlerResult.result);
				expect(result).toContain("[TOOL_ERROR]");
				expect(result).toContain("get_commit_diff failed");
				expect(result).toContain("unknown commit");
				expect(result).toContain("No diff available for this request.");
			}).pipe(Effect.scoped),
		);
	});
});

describe("DiffToolkit diff sanitization", () => {
	test("get_diff handler replaces binary file marker in output", async () => {
		const mockGitCtx = createGitContextMock({
			getDiff: () =>
				Effect.succeed(
					"diff --git a/assets/img.png b/assets/img.png\nindex abc..def 100644\nBinary files a/assets/img.png and b/assets/img.png differ\n",
				),
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
				const stream = yield* toolkit.handle("get_diff", {});
				const last = yield* Stream.runLast(stream);
				const handlerResult = Option.getOrThrow(last);
				const result = String(handlerResult.result);
				expect(result).toContain("[binary file: assets/img.png]");
				expect(result).not.toContain("Binary files");
			}).pipe(Effect.scoped),
		);
	});

	test("get_commit_diff handler replaces binary file marker in output", async () => {
		const mockGitCtx = createGitContextMock({
			getCommitDiff: () =>
				Effect.succeed(
					"commit abc123\nfeat: add image\n\ndiff --git a/logo.png b/logo.png\nindex 000..111 100644\nBinary files a/logo.png and b/logo.png differ\n",
				),
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
				const result = String(handlerResult.result);
				expect(result).toContain("[binary file: logo.png]");
				expect(result).not.toContain("Binary files");
			}).pipe(Effect.scoped),
		);
	});

	test("get_diff handler caps oversized diff output for AI round-trip safety", async () => {
		const bigDiff = `diff --git a/src/huge.ts b/src/huge.ts\n${"+x\n".repeat(20_000)}`;
		const mockGitCtx = createGitContextMock({
			getDiff: () => Effect.succeed(bigDiff),
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
				const stream = yield* toolkit.handle("get_diff", {});
				const last = yield* Stream.runLast(stream);
				const handlerResult = Option.getOrThrow(last);
				const result = String(handlerResult.result);
				expect(result.length).toBeLessThanOrEqual(MAX_AI_TOOL_ROUNDTRIP_DIFF_CHARS + 300);
				expect(result).toContain("[tool output truncated:");
			}).pipe(Effect.scoped),
		);
	});
});
