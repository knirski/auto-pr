/**
 * Live PullRequestClient interpreter backed by `gh`.
 */

import { Cause, Context, Duration, Effect, Layer, Option, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { PullRequestClientService } from "#auto-pr/interfaces/pull-request-client.js";
import { runCommand } from "#auto-pr/shell.js";
import { PrLookupError, PullRequestFailedError } from "#core/errors.js";
import { parseGhPrCreateOutput } from "#core/gh-pr-url.js";
import { parseFirstJsonObject } from "#core/parse-model-json.js";

const PrInfoSchema = Schema.Struct({
	number: Schema.Number,
	url: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
	title: Schema.optional(Schema.String),
});

const GH_COMMAND_TIMEOUT = Duration.seconds(30);

/**
 * Heuristic: `runCommand` maps gh failures to `PullRequestFailedError` with `String(platformError)`.
 * Treat as “no open PR” only for `gh pr view` phrasing we expect when the branch has no PR.
 * Keep substrings specific so unrelated errors that mention “PR” are not swallowed.
 */
function ghStdoutMeansNoPrYet(cause: string): boolean {
	const m = cause.toLowerCase();
	return (
		m.includes("no pull requests found") ||
		m.includes("no pull requests match") ||
		m.includes("could not find any pull requests") ||
		m.includes("no pr found")
	);
}

export class PullRequestClient extends Context.Service<
	PullRequestClient,
	PullRequestClientService
>()("auto-pr/pull-request-client") {
	static Live(workspace: string): Layer.Layer<PullRequestClient, never, ChildProcessSpawner> {
		return Layer.effect(
			PullRequestClient,
			Effect.gen(function* () {
				const spawner = yield* ChildProcessSpawner;
				const run = (args: readonly string[]) =>
					runCommand("gh", [...args], workspace).pipe(
						Effect.provideService(ChildProcessSpawner, spawner),
					);
				const runWithLookupTimeout = (args: readonly string[], branch: string) =>
					run(args).pipe(
						Effect.timeout(GH_COMMAND_TIMEOUT),
						Effect.mapError((e) =>
							Cause.isTimeoutError(e)
								? new PrLookupError({ branch, cause: "gh pr view timed out after 30s" })
								: e,
						),
					);
				const runWithPullRequestTimeout = (args: readonly string[], op: string) =>
					run(args).pipe(
						Effect.timeout(GH_COMMAND_TIMEOUT),
						Effect.mapError((e) =>
							Cause.isTimeoutError(e)
								? new PullRequestFailedError({ cause: `gh ${op} timed out after 30s` })
								: e,
						),
					);

				const findByBranch = Effect.fn("PullRequestClient.findByBranch")(function* (
					branch: string,
				) {
					const toLookupError = (cause: string): PrLookupError =>
						new PrLookupError({ branch, cause });

					const stdout = yield* runWithLookupTimeout(
						["pr", "view", branch, "--json", "number,url,title"],
						branch,
					).pipe(
						Effect.catchTag("PullRequestFailedError", (e) =>
							ghStdoutMeansNoPrYet(e.cause)
								? Effect.succeed("")
								: Effect.fail(toLookupError(e.cause)),
						),
					);
					const trimmed = stdout.trim();
					if (trimmed === "") return Option.none();

					const parsed = yield* Effect.fromResult(parseFirstJsonObject(trimmed)).pipe(
						Effect.mapError((e) => toLookupError(e.message)),
					);
					const decoded = yield* Schema.decodeUnknownEffect(PrInfoSchema)(parsed).pipe(
						Effect.mapError((e) => toLookupError(String(e))),
					);
					return Option.some(decoded);
				});

				const update = Effect.fn("PullRequestClient.update")(function* (
					prNumber: number,
					title: string,
					bodyPath: string,
				) {
					yield* runWithPullRequestTimeout(
						["pr", "edit", String(prNumber), "--title", title, "--body-file", bodyPath],
						"pr edit",
					);
				});

				const create = Effect.fn("PullRequestClient.create")(function* (
					headBranch: string,
					baseBranch: string,
					title: string,
					bodyPath: string,
				) {
					const stdout = yield* runWithPullRequestTimeout(
						[
							"pr",
							"create",
							"--head",
							headBranch,
							"--base",
							baseBranch,
							"--title",
							title,
							"--body-file",
							bodyPath,
						],
						"pr create",
					);
					return yield* Effect.fromResult(parseGhPrCreateOutput(stdout));
				});

				return { findByBranch, update, create };
			}),
		);
	}
}
