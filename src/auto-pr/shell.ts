/**
 * Shared shell (Effect) for auto-PR scripts. I/O, exec, layers.
 */

import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { Effect, FileSystem, Layer, Logger } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { formatGhOutput } from "#auto-pr/core.js";
import { formatError, PullRequestFailedError } from "#auto-pr/errors.js";

/** Platform layer for auto-PR scripts: FileSystem + Path. */
export const PlatformLayer = BunFileSystem.layer.pipe(Layer.provideMerge(BunPath.layer));

/** ChildProcessSpawner layer (requires FileSystem + Path). */
export const ChildProcessSpawnerLayer = BunChildProcessSpawner.layer.pipe(
	Layer.provide(PlatformLayer),
);

/** Run a command and return stdout. Maps PlatformError to PullRequestFailedError. */
export const runCommand = Effect.fn("runCommand")(function* (
	command: string,
	args: string[],
	cwd: string,
) {
	const spawner = yield* ChildProcessSpawner;
	return yield* spawner
		.string(ChildProcess.make(command, args, { cwd }))
		.pipe(Effect.mapError((e) => new PullRequestFailedError({ cause: String(e) })));
});

/** Append entries to GITHUB_OUTPUT file. */
export const appendGhOutput = Effect.fn("appendGhOutput")(function* (
	path: string,
	entries: ReadonlyArray<{ key: string; value: string }>,
) {
	const fs = yield* FileSystem.FileSystem;
	const content = formatGhOutput(entries);
	yield* fs.writeFileString(path, content, { flag: "a" });
});

/** Respect NO_COLOR (https://no-color.org): disable colors when set, for CI/scripting. */
export const AutoPrLoggerLayer = Logger.layer([
	Logger.consolePretty({ colors: process.env.NO_COLOR === undefined }),
]).pipe(Layer.provide(Layer.succeed(Logger.LogToStderr)(true)));

/** Debug hint for error output when AUTO_PR_DEBUG is not set. Reads process.env. */
export function getDebugHint(): string {
	return process.env.AUTO_PR_DEBUG === "1" || process.env.AUTO_PR_DEBUG === "true"
		? ""
		: " Set AUTO_PR_DEBUG=1 for verbose output.";
}

/** Prepares a main program with error logging. Requires Logger in environment. Used by runMain. */
export function withMainSetup(
	program: Effect.Effect<void, unknown>,
	eventName: string,
): Effect.Effect<void, unknown, Logger.Logger<unknown, void>> {
	return program.pipe(
		Effect.tapError((e) =>
			Effect.logError({
				event: eventName,
				error: formatError(e) + getDebugHint(),
			}),
		),
	);
}

/** Run main with BunRuntime. Provides Logger, logs errors, exits 0/1. Call from `if (import.meta.main)`. */
export function runMain(program: Effect.Effect<void, unknown>, eventName: string): void {
	const main = withMainSetup(program, eventName).pipe(Effect.provide(AutoPrLoggerLayer));
	BunRuntime.runMain(main as Effect.Effect<void, unknown>);
}
