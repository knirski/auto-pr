/**
 * Shared shell (Effect) for auto-PR scripts. I/O, exec, layers.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { Effect, Exit, FileSystem, Layer, Logger } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { formatGhOutput } from "./core.js";
import { formatAutoPrError, GhPrFailed } from "./errors.js";

/** Platform layer for auto-PR scripts: FileSystem + Path. */
export const AutoPrPlatformLayer = NodeFileSystem.layer.pipe(Layer.provideMerge(NodePath.layer));

/** ChildProcessSpawner layer (requires FileSystem + Path). */
export const ChildProcessSpawnerLayer = NodeChildProcessSpawner.layer.pipe(
	Layer.provide(AutoPrPlatformLayer),
);

/** Run a command and return stdout. Maps PlatformError to GhPrFailed. */
export function runCommand(
	command: string,
	args: string[],
	cwd: string,
): Effect.Effect<string, GhPrFailed, ChildProcessSpawner> {
	return Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner;
		return yield* spawner
			.string(ChildProcess.make(command, args, { cwd }))
			.pipe(Effect.mapError((e) => new GhPrFailed({ cause: String(e) })));
	});
}

/** Append entries to GITHUB_OUTPUT file. */
export function appendGhOutput(
	path: string,
	entries: ReadonlyArray<{ key: string; value: string }>,
): Effect.Effect<void, Error, FileSystem.FileSystem> {
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const content = formatGhOutput(entries);
		yield* fs.writeFileString(path, content, { flag: "a" });
	});
}

/** Logger layer for auto-PR scripts. Respects NO_COLOR. */
export const AutoPrLoggerLayer = Logger.layer([
	Logger.consolePretty({ colors: process.env.NO_COLOR === undefined }),
]).pipe(Layer.provide(Layer.succeed(Logger.LogToStderr)(true)));

/** Run program with Logger, log errors, exit with 0/1. Use at script entry. */
function runAutoPrMain(
	program: Effect.Effect<void, unknown>,
	eventName: string,
): Effect.Effect<never> {
	const debugHint =
		process.env.AUTO_PR_DEBUG === "1" || process.env.AUTO_PR_DEBUG === "true"
			? ""
			: " Set AUTO_PR_DEBUG=1 for verbose output.";
	return program.pipe(
		Effect.provide(AutoPrLoggerLayer),
		Effect.tapError((e) =>
			Effect.logError({
				event: eventName,
				error: formatAutoPrError(e) + debugHint,
			}),
		),
		Effect.exit,
		Effect.flatMap((exit) =>
			Effect.sync(() => {
				process.exit(Exit.isSuccess(exit) ? 0 : 1);
			}),
		),
	);
}

/** Run main with NodeRuntime. Call from `if (import.meta.main)`. */
export function runMain(program: Effect.Effect<void, unknown>, eventName: string): void {
	NodeRuntime.runMain(runAutoPrMain(program, eventName));
}
