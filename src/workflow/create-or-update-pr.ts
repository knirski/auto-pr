/**
 * Create or update a PR. Thin gh wrapper.
 *
 * Requires env: GH_TOKEN, BRANCH, DEFAULT_BRANCH, TITLE, BODY_FILE
 *
 * Validates required env at startup, then calls gh pr view --json → gh pr edit or gh pr create.
 * Uses --json number,url for reliable PR existence check (avoids exit-code ambiguity).
 * Uses PR number for edits (more robust than branch name). Uses --head for create (CI-safe).
 *
 * Run: npx tsx src/workflow/create-or-update-pr.ts (or: node dist/workflow/auto-pr-create-or-update-pr.mjs)
 */

import { Duration, Effect, FileSystem, Option, Schedule, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import {
	AutoPrLoggerLayer,
	AutoPrPlatformLayer,
	BodyFileNotFoundError,
	ChildProcessSpawnerLayer,
	CreateOrUpdatePrConfig,
	CreateOrUpdatePrConfigLayer,
	type FileSystemError,
	mapFsError,
	type PullRequestFailedError,
	runCommand,
	runMain,
} from "#auto-pr";

// ─── Constants ────────────────────────────────────────────────────────────

const GH_RETRY_ATTEMPTS = 3;
const GH_RETRY_DELAY_MS = 5000;

const PrInfoSchema = Schema.Struct({
	number: Schema.Number,
	url: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});
type PrInfo = Schema.Schema.Type<typeof PrInfoSchema>;

/** Reliable PR existence check: gh pr view --json number,url. Returns Option with PR info if exists. */
function ghPrViewJson(
	branch: string,
	cwd: string,
): Effect.Effect<Option.Option<PrInfo>, never, ChildProcessSpawner> {
	return Effect.gen(function* () {
		const stdout = yield* runCommand("gh", ["pr", "view", branch, "--json", "number,url"], cwd);
		const trimmed = stdout.trim();
		if (!trimmed) return Option.none();
		const parsed = yield* Effect.try({
			try: () => JSON.parse(trimmed) as unknown,
			catch: () => null,
		}).pipe(Effect.catch(() => Effect.succeed(null)));
		if (parsed === null) return Option.none();
		return yield* Schema.decodeUnknownEffect(PrInfoSchema)(parsed).pipe(
			Effect.map(Option.some),
			Effect.catch(() => Effect.succeed(Option.none())),
		);
	}).pipe(Effect.catch(() => Effect.succeed(Option.none())));
}

function ghPrEdit(
	prNumber: number,
	title: string,
	bodyPath: string,
	cwd: string,
): Effect.Effect<void, PullRequestFailedError, ChildProcessSpawner> {
	return runCommand(
		"gh",
		["pr", "edit", String(prNumber), "--title", title, "--body-file", bodyPath],
		cwd,
	);
}

function ghPrCreate(
	headBranch: string,
	baseBranch: string,
	title: string,
	bodyPath: string,
	cwd: string,
): Effect.Effect<string, PullRequestFailedError, ChildProcessSpawner> {
	return runCommand(
		"gh",
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
		cwd,
	);
}

function createGhRetrySchedule(branch: string) {
	return Schedule.recurs(GH_RETRY_ATTEMPTS - 1).pipe(
		Schedule.addDelay(() =>
			Effect.logWarning({
				event: "create_or_update_pr",
				status: "gh_retry",
				branch,
				message: "gh failed, retrying in 5s...",
			}).pipe(Effect.as(Duration.millis(GH_RETRY_DELAY_MS))),
		),
	);
}

function runGhWithRetry<R, E, A>(
	effect: Effect.Effect<A, E, R>,
	branch: string,
): Effect.Effect<A, E, R> {
	return effect.pipe(
		Effect.retry(createGhRetrySchedule(branch)),
		Effect.tapError(() =>
			Effect.logError({
				event: "create_or_update_pr",
				status: "failed_after_retries",
				branch,
				message: "gh pr failed after 3 attempts",
			}),
		),
	);
}

function extractPrUrl(stdout: string): string {
	return stdout.trim().split("\n").at(-1) ?? "";
}

type CreateOrUpdatePrError = PullRequestFailedError | BodyFileNotFoundError | FileSystemError;

/** Main pipeline. Exported for tests. */
export function runCreateOrUpdatePr(params: {
	branch: string;
	defaultBranch: string;
	title: string;
	bodyFile: string;
	workspace: string;
}): Effect.Effect<void, CreateOrUpdatePrError, ChildProcessSpawner | FileSystem.FileSystem> {
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const bodyExists = yield* fs
			.exists(params.bodyFile)
			.pipe(mapFsError(params.bodyFile, "exists"));
		if (!bodyExists) {
			return yield* Effect.fail(new BodyFileNotFoundError({ path: params.bodyFile }));
		}

		const cwd = params.workspace;

		const prInfo = yield* ghPrViewJson(params.branch, cwd);
		if (Option.isSome(prInfo)) {
			const { number: prNumber, url } = prInfo.value;
			yield* Effect.log({
				event: "create_or_update_pr",
				status: "updating",
				branch: params.branch,
				base: params.defaultBranch,
				prNumber,
				titlePreview: params.title.slice(0, 50),
			});
			yield* runGhWithRetry(ghPrEdit(prNumber, params.title, params.bodyFile, cwd), params.branch);
			yield* Effect.log({
				event: "create_or_update_pr",
				status: "updated",
				url,
				branch: params.branch,
			});
		} else {
			yield* Effect.log({
				event: "create_or_update_pr",
				status: "creating",
				head: params.branch,
				base: params.defaultBranch,
				titlePreview: params.title.slice(0, 50),
			});
			const stdout = yield* runGhWithRetry(
				ghPrCreate(params.branch, params.defaultBranch, params.title, params.bodyFile, cwd),
				params.branch,
			);
			const url = extractPrUrl(stdout);
			if (url) {
				yield* Effect.log({
					event: "create_or_update_pr",
					status: "created",
					url,
					branch: params.branch,
				});
			}
		}
	});
}

// ─── Entry ──────────────────────────────────────────────────────────────────

const program = Effect.gen(function* () {
	const params = yield* CreateOrUpdatePrConfig;
	yield* runCreateOrUpdatePr(params);
}).pipe(
	Effect.provide(CreateOrUpdatePrConfigLayer),
	Effect.provide(AutoPrPlatformLayer),
	Effect.provide(ChildProcessSpawnerLayer),
	Effect.provide(AutoPrLoggerLayer),
);

if (import.meta.main) {
	runMain(program, "create_or_update_pr_failed");
}
