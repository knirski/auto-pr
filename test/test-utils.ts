/**
 * Test utilities for auto-pr. Use Layer.mock() for service mocks.
 * For tests needing real time (no TestClock), use layer(MyLayer, { excludeTestServices: true }).
 */
import { Effect, FileSystem, Layer, Logger, Path, Stream } from "effect";
import { systemError } from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { AutoPrPlatformLayer } from "#auto-pr";

/**
 * Silent logger for tests. Suppresses all log output.
 * No-op logger: Logger.make(() => {}) does nothing; single layer avoids mergeAll.
 */
export const SilentLoggerLayer = Logger.layer([
	Logger.make<unknown, void>(() => {}),
]) as Layer.Layer<Logger.Logger<unknown, void>>;
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

/** Mock Ollama response: string, { response, status?, prompt_eval_count?, eval_count? }, or { fail } to fail with Error. */
export type OllamaMockResponse =
	| string
	| {
			response: string;
			status?: number;
			prompt_eval_count?: number;
			eval_count?: number;
	  }
	| { fail: string };

/** Single response or array (call-based). */
export type OllamaMockResponses = OllamaMockResponse | readonly OllamaMockResponse[];

type OllamaMockItem =
	| { response: string; status: number; prompt_eval_count: number; eval_count: number }
	| { fail: string };

function normalizeResponse(r: OllamaMockResponse): OllamaMockItem {
	if (typeof r === "string")
		return { response: r, status: 200, prompt_eval_count: 0, eval_count: 0 };
	if ("fail" in r) return r;
	return {
		response: r.response,
		status: r.status ?? 200,
		prompt_eval_count: r.prompt_eval_count ?? 0,
		eval_count: r.eval_count ?? 0,
	};
}

/**
 * Mock fetch for Ollama API. Returns canned responses without network.
 * Use with ollama package: new Ollama({ host, fetch: createOllamaMockFetch(...) }).
 *
 * @param responses - Single string (same for all calls) or array (call-based).
 *   Use { response: string, status?: number } for HTTP errors (e.g. status 500).
 */
export function createOllamaMockFetch(responses: OllamaMockResponses): typeof fetch {
	const arr: OllamaMockItem[] = (Array.isArray(responses) ? responses : [responses]).map((r) =>
		normalizeResponse(r),
	);
	let callCount = 0;
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!String(url).includes("/api/generate") || init?.method?.toUpperCase() !== "POST") {
			throw new Error("createOllamaMockFetch: unexpected request");
		}
		const idx = Math.min(callCount++, arr.length - 1);
		const item = arr[idx] ?? arr[arr.length - 1];
		if (!item) throw new Error("createOllamaMockFetch: no responses");
		if ("fail" in item) throw new Error(item.fail);
		const { response, status, prompt_eval_count, eval_count } = item;
		return new Response(JSON.stringify({ response, prompt_eval_count, eval_count }), { status });
	}) as typeof fetch;
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
