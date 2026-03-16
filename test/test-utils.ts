/**
 * Test utilities for auto-pr. Use Layer.mock() for service mocks.
 * For tests needing real time (no TestClock), use layer(MyLayer, { excludeTestServices: true }).
 */
import { Effect, FileSystem, Layer, Logger, Path, Ref, Stream } from "effect";
import { systemError } from "effect/PlatformError";
import * as Http from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { AutoPrPlatformLayer } from "#auto-pr";

export const SilentLoggerLayer = Logger.layer([]);
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

/** Mock Ollama response: string or { response, status? }. */
export type OllamaMockResponse = string | { response: string; status?: number };

function normalizeResponse(r: OllamaMockResponse): { response: string; status: number } {
	if (typeof r === "string") return { response: r, status: 200 };
	return { response: r.response, status: r.status ?? 200 };
}

/**
 * Mock HttpClient for Ollama API. Returns canned responses without network.
 *
 * @param responses - Single string (same for all calls) or array (call-based).
 *   Use { response: string, status?: number } for HTTP errors (e.g. status 500).
 */
export function OllamaHttpClientMock(
	responses: OllamaMockResponse | readonly OllamaMockResponse[],
): Layer.Layer<Http.HttpClient.HttpClient> {
	const arr: Array<{ response: string; status: number }> = Array.isArray(responses)
		? responses.map((r) => normalizeResponse(r))
		: [normalizeResponse(responses as OllamaMockResponse)];
	return Layer.effect(
		Http.HttpClient.HttpClient,
		Ref.make(0).pipe(
			Effect.flatMap((callCount) =>
				Effect.succeed(
					Http.HttpClient.make((request, url) => {
						if (!String(url).includes("/api/generate")) {
							return Effect.die(new Error("OllamaHttpClientMock: unexpected URL"));
						}
						return Ref.modify(callCount, (n) => [n + 1, n]).pipe(
							Effect.flatMap((index) => {
								const item = arr[Math.min(index, arr.length - 1)] ?? arr[arr.length - 1];
								const { response, status } = item ?? {
									response: "",
									status: 200,
								};
								const webResponse = new Response(JSON.stringify({ response }), {
									status,
								});
								return Effect.succeed(Http.HttpClientResponse.fromWeb(request, webResponse));
							}),
						);
					}),
				),
			),
		),
	);
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
