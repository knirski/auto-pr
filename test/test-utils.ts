import { Effect, FileSystem, Layer, Logger, Path, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { AutoPrPlatformLayer } from "../scripts/auto-pr/index.js";

export const SilentLoggerLayer = Logger.layer([]);
export const TestBaseLayer = Layer.mergeAll(SilentLoggerLayer, AutoPrPlatformLayer);

/** Mock ChildProcessSpawner for tests. string() returns empty; stream methods return empty streams. */
export const ChildProcessSpawnerTestMock = Layer.mock(ChildProcessSpawner)({
	string: () => Effect.succeed(""),
	streamString: () => Stream.empty,
	streamLines: () => Stream.empty,
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
