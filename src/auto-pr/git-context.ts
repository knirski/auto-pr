/**
 * Typed interface for all git read operations. Single source of truth.
 * Live implementation uses ChildProcessSpawner (runCommand).
 * Workspace (cwd) is baked into the live layer — not a per-method parameter.
 */

import { Cause, Context, Duration, Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { runCommand } from "#auto-pr/shell.js";
import { unknownToMessage } from "#core/string.js";

export interface GitContext {
	readonly getLog: (baseRef: string, headRef: string) => Effect.Effect<string, Error>;
	readonly getChangedFiles: (baseRef: string, headRef: string) => Effect.Effect<string, Error>;
	readonly getDiffStat: (baseRef: string, headRef: string) => Effect.Effect<string, Error>;
	readonly getDiff: (
		baseRef: string,
		headRef: string,
		path?: string,
	) => Effect.Effect<string, Error>;
	readonly getCommitDiff: (hash: string) => Effect.Effect<string, Error>;
}

export const GitContext = Context.Service<GitContext>("GitContext");

const LOG_FORMAT = "---COMMIT---%n%H%n%s%n%n%b";

export const GIT_COMMAND_TIMEOUT = Duration.seconds(30);

/** Build live GitContext with workspace baked in. Returns a Layer. */
export function GitContextLive(
	workspace: string,
): Layer.Layer<GitContext, never, ChildProcessSpawner> {
	return Layer.effect(
		GitContext,
		Effect.gen(function* () {
			// Acquire spawner once at construction time; close over it in each method.
			const spawner = yield* ChildProcessSpawner;

			const run = (cmd: string, args: string[]) =>
				runCommand(cmd, args, workspace).pipe(
					Effect.timeout(GIT_COMMAND_TIMEOUT),
					Effect.mapError((e) => {
						if (Cause.isTimeoutError(e)) {
							return new Error(`git ${args[0] ?? cmd} timed out after 30s`);
						}
						return new Error(unknownToMessage(e));
					}),
					Effect.provideService(ChildProcessSpawner, spawner),
				);

			const getLog = Effect.fn("GitContext.getLog")(function* (baseRef: string, headRef: string) {
				return yield* run("git", ["log", `--format=${LOG_FORMAT}`, `${baseRef}..${headRef}`]);
			});

			const getChangedFiles = Effect.fn("GitContext.getChangedFiles")(function* (
				baseRef: string,
				headRef: string,
			) {
				return yield* run("git", ["diff", "--name-only", `${baseRef}..${headRef}`]);
			});

			const getDiffStat = Effect.fn("GitContext.getDiffStat")(function* (
				baseRef: string,
				headRef: string,
			) {
				return yield* run("git", ["diff", "--stat", `${baseRef}..${headRef}`]);
			});

			const getDiff = Effect.fn("GitContext.getDiff")(function* (
				baseRef: string,
				headRef: string,
				path?: string,
			) {
				const args =
					path !== undefined
						? ["diff", `${baseRef}..${headRef}`, "--", path]
						: ["diff", `${baseRef}..${headRef}`];
				return yield* run("git", args);
			});

			const getCommitDiff = Effect.fn("GitContext.getCommitDiff")(function* (hash: string) {
				return yield* run("git", ["show", hash]);
			});

			return { getLog, getChangedFiles, getDiffStat, getDiff, getCommitDiff };
		}),
	);
}
