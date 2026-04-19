/**
 * Test utilities for auto-pr. Use Layer.mock() for service mocks.
 * For tests needing real time (no TestClock), use layer(MyLayer, { excludeTestServices: true }).
 */
import { Effect, FileSystem, Layer, Logger, Path, Stream } from "effect";
import { systemError } from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { AutoPrPlatformLayer, cleanGitEnv } from "#auto-pr";

export { cleanGitEnv };

import type { GitContext } from "#auto-pr/git-context.js";

/**
 * Silent logger for tests. Suppresses all log output.
 * No-op logger: Logger.make(() => {}) does nothing; single layer avoids mergeAll.
 */
export const SilentLoggerLayer = Logger.layer([Logger.make<unknown, void>(() => {})]);
export const TestBaseLayer = Layer.mergeAll(SilentLoggerLayer, AutoPrPlatformLayer);

/** Mock ChildProcessSpawner for tests. string() returns empty; stream methods return empty streams. */
export const ChildProcessSpawnerTestMock = Layer.mock(ChildProcessSpawner)({
	string: () => Effect.succeed(""),
	streamString: () => Stream.empty,
	streamLines: () => Stream.empty,
});

/**
 * Mock that simulates "no PR exists" for gh pr view --json, success for gh pr create/edit.
 * Exercises the create path (vs update path) in runCreateOrUpdatePr.
 */
export const ChildProcessSpawnerCreatePathMock = Layer.mock(ChildProcessSpawner)({
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
			return Effect.succeed("https://github.com/owner/repo/pull/99\n");
		}
		return Effect.succeed("");
	},
	streamString: () => Stream.empty,
	streamLines: () => Stream.empty,
});

/**
 * Mock that simulates "PR exists" for gh pr view --json (returns number,url), success for gh pr edit.
 * Exercises the update path in runCreateOrUpdatePr.
 */
export const ChildProcessSpawnerUpdatePathMock = Layer.mock(ChildProcessSpawner)({
	string: (cmd: { _tag: string; command?: string; args?: readonly string[] }) => {
		const args = "args" in cmd ? cmd.args : [];
		if (cmd.command === "gh" && args[1] === "view" && args.includes("--json")) {
			return Effect.succeed('{"number":1,"url":"https://github.com/owner/repo/pull/1"}');
		}
		return Effect.succeed("");
	},
	streamString: () => Stream.empty,
	streamLines: () => Stream.empty,
});

/** Mock OpenAI-compatible chat completion: assistant `content` string (JSON matching `TitleDescriptionSchema` for generate-content). */
export type OpenAiChatCompletionMockResponse =
	| string
	| { content: string; status?: number }
	| { fail: string };

export type OpenAiChatCompletionMockResponses =
	| OpenAiChatCompletionMockResponse
	| readonly OpenAiChatCompletionMockResponse[];

type OpenAiMockItem = { content: string; status: number } | { fail: string };

function normalizeOpenAiResponse(r: OpenAiChatCompletionMockResponse): OpenAiMockItem {
	if (typeof r === "string") return { content: r, status: 200 };
	if ("fail" in r) return r;
	return { content: r.content, status: r.status ?? 200 };
}

/**
 * Mock fetch for OpenAI-compatible `POST …/chat/completions`. Use with `aiProviderLayerFromConfig` + `options.fetch`.
 */
export function createOpenAiChatCompletionsMockFetch(
	responses: OpenAiChatCompletionMockResponses,
): typeof fetch {
	const arr: OpenAiMockItem[] = (Array.isArray(responses) ? responses : [responses]).map((r) =>
		normalizeOpenAiResponse(r),
	);
	let callCount = 0;
	const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!String(url).includes("/chat/completions") || init?.method?.toUpperCase() !== "POST") {
			throw new Error("createOpenAiChatCompletionsMockFetch: unexpected request");
		}
		const idx = Math.min(callCount++, arr.length - 1);
		const item = arr[idx] ?? arr[arr.length - 1];
		if (!item) throw new Error("createOpenAiChatCompletionsMockFetch: no responses");
		if ("fail" in item) throw new Error(item.fail);
		const { content, status } = item;
		const body = {
			id: "chatcmpl-mock",
			object: "chat.completion",
			created: 0,
			model: "mock",
			choices: [
				{
					index: 0,
					finish_reason: "stop",
					message: { role: "assistant", content },
				},
			],
		};
		return new Response(JSON.stringify(body), { status });
	};
	return Object.assign(impl, {
		preconnect: globalThis.fetch.preconnect.bind(globalThis.fetch),
	});
}

/** Mock GitContext for tests. Override individual methods as needed. */
export function createGitContextMock(overrides?: Partial<GitContext>): GitContext {
	const noOp = () => Effect.succeed("");
	return {
		getLog: overrides?.getLog ?? noOp,
		getChangedFiles: overrides?.getChangedFiles ?? noOp,
		getDiffStat: overrides?.getDiffStat ?? noOp,
		getDiff: overrides?.getDiff ?? noOp,
		getCommitDiff: overrides?.getCommitDiff ?? noOp,
	};
}

/** Effect-based temp dir for use with layer() / it.effect. */
export const createTestTempDirEffect = (prefix = "auto-pr-") =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const pathApi = yield* Path.Path;
		const tmpDir = yield* fs.makeTempDirectory({ prefix });
		return {
			path: tmpDir,
			join: (...s: string[]) => pathApi.join(tmpDir, ...s),
			writeFile: (filePath: string, content: string | Uint8Array) =>
				typeof content === "string"
					? fs.writeFileString(filePath, content)
					: fs.writeFile(filePath, content),
			remove: () => fs.remove(tmpDir, { recursive: true }).pipe(Effect.catch(() => Effect.void)),
		};
	});
