/**
 * Live PullRequestClient interpreter backed by `gh`.
 */

import { Context, Effect, Layer, Option, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { PullRequestClientService } from "#auto-pr/interfaces/pull-request-client.js";
import { runCommand } from "#auto-pr/shell.js";
import { PrLookupError } from "#core/errors.js";
import { parseGhPrCreateOutput } from "#core/gh-pr-url.js";
import { parseFirstJsonObject } from "#core/parse-model-json.js";

const PrInfoSchema = Schema.Struct({
	number: Schema.Number,
	url: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});

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

				const findByBranch = Effect.fn("PullRequestClient.findByBranch")(function* (
					branch: string,
				) {
					const toLookupError = (cause: string): PrLookupError =>
						new PrLookupError({ branch, cause });

					const stdout = yield* run(["pr", "view", branch, "--json", "number,url"]).pipe(
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
					yield* run(["pr", "edit", String(prNumber), "--title", title, "--body-file", bodyPath]);
				});

				const create = Effect.fn("PullRequestClient.create")(function* (
					headBranch: string,
					baseBranch: string,
					title: string,
					bodyPath: string,
				) {
					const stdout = yield* run([
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
					]);
					return yield* Effect.fromResult(parseGhPrCreateOutput(stdout));
				});

				return { findByBranch, update, create };
			}),
		);
	}
}
