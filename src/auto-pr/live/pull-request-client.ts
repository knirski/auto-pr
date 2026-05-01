/**
 * Live PullRequestClient interpreter backed by Octokit REST API.
 */

import { Cause, Context, Duration, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { Octokit } from "octokit";
import type { PullRequestClientService } from "#auto-pr/interfaces/pull-request-client.js";
import { PullRequestFailedError, PullRequestLookupError } from "#core/errors.js";

const PullRequestInfoSchema = Schema.Struct({
	number: Schema.Number,
	url: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
	title: Schema.optional(Schema.String),
});

const API_TIMEOUT = Duration.seconds(30);

type PullsApi = {
	readonly list: (args: {
		readonly owner: string;
		readonly repo: string;
		readonly state: "open";
		readonly head: string;
		readonly per_page: 1;
	}) => Promise<{
		readonly data: ReadonlyArray<{
			readonly number: number;
			readonly html_url: string;
			readonly title?: string;
		}>;
	}>;
	readonly update: (args: {
		readonly owner: string;
		readonly repo: string;
		readonly pull_number: number;
		readonly title: string;
		readonly body: string;
	}) => Promise<{ readonly data: { readonly html_url: string } }>;
	readonly create: (args: {
		readonly owner: string;
		readonly repo: string;
		readonly head: string;
		readonly base: string;
		readonly title: string;
		readonly body: string;
	}) => Promise<{ readonly data: { readonly html_url: string } }>;
};

type OctokitLike = { readonly rest: { readonly pulls: PullsApi } };

export type PullRequestClientLiveDeps = {
	readonly octokitFactory?: (token: string) => OctokitLike;
	readonly githubRepository?: string;
	readonly ghRepo?: string;
	readonly ghToken?: string;
	readonly apiTimeout?: Duration.Duration;
};

type RepoIdentity = { readonly owner: string; readonly repo: string };

function stringifyUnknown(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}

function parseRepoIdentity(value: string): Option.Option<RepoIdentity> {
	const trimmed = value.trim();
	if (trimmed === "") return Option.none();
	const parts = trimmed.split("/");
	if (parts.length !== 2) return Option.none();
	const [owner, repo] = parts;
	if (owner === undefined || repo === undefined || owner.trim() === "" || repo.trim() === "") {
		return Option.none();
	}
	return Option.some({ owner: owner.trim(), repo: repo.trim() });
}

function resolveRepoIdentity(
	input: PullRequestClientLiveDeps,
): Effect.Effect<RepoIdentity, string> {
	const raw =
		input.githubRepository ?? input.ghRepo ?? process.env.GITHUB_REPOSITORY ?? process.env.GH_REPO;
	if (raw === undefined || raw.trim() === "") {
		return Effect.fail("Missing repository config: set GITHUB_REPOSITORY or GH_REPO as owner/repo");
	}
	return Option.match(parseRepoIdentity(raw), {
		onNone: () => Effect.fail(`Invalid repository config: ${raw}. Expected owner/repo`),
		onSome: Effect.succeed,
	});
}

function resolveToken(input: PullRequestClientLiveDeps): Effect.Effect<string, string> {
	const raw = input.ghToken ?? process.env.GH_TOKEN;
	if (raw === undefined || raw.trim() === "") return Effect.fail("Missing GH_TOKEN");
	return Effect.succeed(raw);
}

function makeOctokit(deps: PullRequestClientLiveDeps, token: string): OctokitLike {
	if (deps.octokitFactory !== undefined) return deps.octokitFactory(token);
	return new Octokit({ auth: token });
}

export class PullRequestClient extends Context.Service<
	PullRequestClient,
	PullRequestClientService
>()("auto-pr/pull-request-client") {
	static Live(
		_workspace: string,
		deps: PullRequestClientLiveDeps = {},
	): Layer.Layer<PullRequestClient, never, FileSystem.FileSystem> {
		return Layer.effect(
			PullRequestClient,
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const timeout = deps.apiTimeout ?? API_TIMEOUT;

				const findByBranch = Effect.fn("PullRequestClient.findByBranch")(function* (
					branch: string,
				) {
					const toLookupError = (cause: string) => new PullRequestLookupError({ branch, cause });
					const repo = yield* resolveRepoIdentity(deps).pipe(Effect.mapError(toLookupError));
					const token = yield* resolveToken(deps).pipe(Effect.mapError(toLookupError));
					const octokit = makeOctokit(deps, token);
					const response = yield* Effect.tryPromise({
						try: () =>
							octokit.rest.pulls.list({
								owner: repo.owner,
								repo: repo.repo,
								state: "open",
								head: `${repo.owner}:${branch}`,
								per_page: 1,
							}),
						catch: (e) => toLookupError(stringifyUnknown(e)),
					}).pipe(
						Effect.timeout(timeout),
						Effect.mapError((e) =>
							Cause.isTimeoutError(e) ? toLookupError("Octokit PR lookup timed out after 30s") : e,
						),
					);

					const first = response.data[0];
					if (first === undefined) return Option.none();
					const decoded = yield* Schema.decodeUnknownEffect(PullRequestInfoSchema)({
						number: first.number,
						url: first.html_url,
						title: first.title,
					}).pipe(Effect.mapError((e) => toLookupError(String(e))));
					return Option.some(decoded);
				});

				const update = Effect.fn("PullRequestClient.update")(function* (
					prNumber: number,
					title: string,
					bodyPath: string,
				) {
					const repo = yield* resolveRepoIdentity(deps).pipe(
						Effect.mapError((cause) => new PullRequestFailedError({ cause })),
					);
					const token = yield* resolveToken(deps).pipe(
						Effect.mapError((cause) => new PullRequestFailedError({ cause })),
					);
					const octokit = makeOctokit(deps, token);
					const body = yield* fs
						.readFileString(bodyPath)
						.pipe(Effect.mapError((e) => new PullRequestFailedError({ cause: String(e) })));
					yield* Effect.tryPromise({
						try: () =>
							octokit.rest.pulls.update({
								owner: repo.owner,
								repo: repo.repo,
								pull_number: prNumber,
								title,
								body,
							}),
						catch: (e) => new PullRequestFailedError({ cause: stringifyUnknown(e) }),
					}).pipe(
						Effect.timeout(timeout),
						Effect.mapError((e) =>
							Cause.isTimeoutError(e)
								? new PullRequestFailedError({ cause: "Octokit PR update timed out after 30s" })
								: e,
						),
					);
				});

				const create = Effect.fn("PullRequestClient.create")(function* (
					headBranch: string,
					baseBranch: string,
					title: string,
					bodyPath: string,
				) {
					const repo = yield* resolveRepoIdentity(deps).pipe(
						Effect.mapError((cause) => new PullRequestFailedError({ cause })),
					);
					const token = yield* resolveToken(deps).pipe(
						Effect.mapError((cause) => new PullRequestFailedError({ cause })),
					);
					const octokit = makeOctokit(deps, token);
					const body = yield* fs
						.readFileString(bodyPath)
						.pipe(Effect.mapError((e) => new PullRequestFailedError({ cause: String(e) })));
					const response = yield* Effect.tryPromise({
						try: () =>
							octokit.rest.pulls.create({
								owner: repo.owner,
								repo: repo.repo,
								head: headBranch,
								base: baseBranch,
								title,
								body,
							}),
						catch: (e) => new PullRequestFailedError({ cause: stringifyUnknown(e) }),
					}).pipe(
						Effect.timeout(timeout),
						Effect.mapError((e) =>
							Cause.isTimeoutError(e)
								? new PullRequestFailedError({ cause: "Octokit PR create timed out after 30s" })
								: e,
						),
					);
					return response.data.html_url;
				});

				return { findByBranch, update, create };
			}),
		);
	}
}
