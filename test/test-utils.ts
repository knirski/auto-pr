/**
 * Test utilities for auto-pr. Use Layer.mock() for service mocks.
 * For tests needing real time (no TestClock), use layer(MyLayer, { excludeTestServices: true }).
 */
import { Effect, FileSystem, Layer, Logger, Path, Stream } from "effect";
import { systemError } from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { AutoPrPlatformLayer, FillPrTemplate } from "#auto-pr";
import type { FillPrTemplateParams } from "#auto-pr/interfaces/fill-pr-template.js";

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

/** Mock FillPrTemplate for workflow tests. Returns fixed title/body; no filesystem or Ollama. */
export const FillPrTemplateTestMock = (overrides?: { title?: string; body?: string }) =>
	Layer.mock(FillPrTemplate)({
		getTitle: (_params: FillPrTemplateParams) =>
			Effect.succeed(overrides?.title ?? "feat: mock title"),
		getBody: (_params: FillPrTemplateParams) =>
			Effect.succeed(overrides?.body ?? "# Mock body\n\nfeat: mock title"),
	});

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
