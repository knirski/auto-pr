/**
 * Typed interface for all git read operations. Single source of truth.
 * Live implementation uses ChildProcessSpawner (runCommand).
 * Workspace (cwd) is baked into the live layer — not a per-method parameter.
 */

import { Effect, Layer, ServiceMap } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { runCommand } from "#auto-pr/shell.js";

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

export const GitContext = ServiceMap.Service<GitContext>("GitContext");

const LOG_FORMAT = "---COMMIT---%n%H%n%s%n%n%b";

/** Build live GitContext with workspace baked in. Returns a Layer. */
export function GitContextLive(
	workspace: string,
): Layer.Layer<GitContext, never, ChildProcessSpawner> {
	return Layer.effect(
		GitContext,
		Effect.gen(function* () {
			return {
				getLog: (baseRef, headRef) =>
					runCommand(
						"git",
						["log", `--format=${LOG_FORMAT}`, `${baseRef}..${headRef}`],
						workspace,
					).pipe(Effect.mapError((e) => new Error(String(e)))),

				getChangedFiles: (baseRef, headRef) =>
					runCommand("git", ["diff", "--name-only", `${baseRef}..${headRef}`], workspace).pipe(
						Effect.mapError((e) => new Error(String(e))),
					),

				getDiffStat: (baseRef, headRef) =>
					runCommand("git", ["diff", "--stat", `${baseRef}..${headRef}`], workspace).pipe(
						Effect.mapError((e) => new Error(String(e))),
					),

				getDiff: (baseRef, headRef, path?) => {
					const args = ["diff", `${baseRef}..${headRef}`];
					if (path !== undefined) args.push("--", path);
					return runCommand("git", args, workspace).pipe(
						Effect.mapError((e) => new Error(String(e))),
					);
				},

				getCommitDiff: (hash) =>
					runCommand("git", ["show", hash], workspace).pipe(
						Effect.mapError((e) => new Error(String(e))),
					),
			};
		}),
	);
}
