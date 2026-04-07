/**
 * Effect Toolkit for AI-accessible git diff tools.
 * Tools: get_diff (branch diff, optionally per-file), get_commit_diff (single commit).
 * Handlers delegate to GitContext.
 */

import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { GitContext } from "#auto-pr/git-context.js";
import { sanitizeDiffForAi } from "#core/sanitize-diff.js";
import { truncateForLog } from "#core/string.js";

const GetDiff = Tool.make("get_diff", {
	description: "Get the git diff for changed files. Provide path for one file, omit for all.",
	parameters: Schema.Struct({
		path: Schema.optionalKey(
			Schema.String.annotate({ description: "File path to diff. Omit for all changed files." }),
		),
	}),
	success: Schema.String,
	failureMode: "return" as const,
});

const GetCommitDiff = Tool.make("get_commit_diff", {
	description: "Get the diff introduced by a specific commit by its hash.",
	parameters: Schema.Struct({
		hash: Schema.String.annotate({
			description: "Full or short commit hash from the commit list.",
		}),
	}),
	success: Schema.String,
	failureMode: "return" as const,
});

export const DiffToolkit = Toolkit.make(GetDiff, GetCommitDiff);

/**
 * Build DiffToolkit handler layer. Captures baseRef and headRef.
 * Requires GitContext in scope.
 */
export function makeDiffToolkitLayer(baseRef: string, headRef: string) {
	return DiffToolkit.toLayer(
		Effect.gen(function* () {
			const git = yield* GitContext;
			return DiffToolkit.of({
				get_diff: Effect.fn("DiffToolkit.get_diff")(function* ({ path }) {
					yield* Effect.log({
						event: "diff_toolkit",
						tool: "get_diff",
						status: "request",
						path: path ?? "(all)",
					});
					const result = yield* git.getDiff(baseRef, headRef, path).pipe(
						Effect.tapError((e) =>
							Effect.log({
								event: "diff_toolkit",
								tool: "get_diff",
								status: "error",
								error: e.message,
							}),
						),
						Effect.catch((e) =>
							Effect.succeed(
								`[TOOL_ERROR] get_diff failed: ${e.message}\nNo diff available for this request.`,
							),
						),
					);
					const sanitized = sanitizeDiffForAi(result);
					yield* Effect.log({
						event: "diff_toolkit",
						tool: "get_diff",
						status: "response",
						response_chars: sanitized.length,
						response_preview: truncateForLog(sanitized, 500),
					});
					return sanitized;
				}),
				get_commit_diff: Effect.fn("DiffToolkit.get_commit_diff")(function* ({ hash }) {
					yield* Effect.log({
						event: "diff_toolkit",
						tool: "get_commit_diff",
						status: "request",
						hash,
					});
					const result = yield* git.getCommitDiff(hash).pipe(
						Effect.tapError((e) =>
							Effect.log({
								event: "diff_toolkit",
								tool: "get_commit_diff",
								status: "error",
								error: e.message,
							}),
						),
						Effect.catch((e) =>
							Effect.succeed(
								`[TOOL_ERROR] get_commit_diff failed: ${e.message}\nNo diff available for this request.`,
							),
						),
					);
					const sanitized = sanitizeDiffForAi(result);
					yield* Effect.log({
						event: "diff_toolkit",
						tool: "get_commit_diff",
						status: "response",
						response_chars: sanitized.length,
						response_preview: truncateForLog(sanitized, 500),
					});
					return sanitized;
				}),
			});
		}),
	);
}
