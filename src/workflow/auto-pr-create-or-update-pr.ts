/**
 * Create or update a PR. Workflow shell over PullRequestClient.
 *
 * Requires env: GH_TOKEN, BRANCH, DEFAULT_BRANCH, GITHUB_WORKSPACE. Reads `{GITHUB_WORKSPACE}/pr-title.txt` and `{GITHUB_WORKSPACE}/pr-body.md`.
 *
 * Validates required env at startup, then calls gh pr view --json → gh pr edit or gh pr create.
 * Uses --json number,url for reliable PR existence check (avoids exit-code ambiguity).
 * Uses PR number for edits (more robust than branch name). Uses --head for create (CI-safe).
 *
 * This repo: bun run create-or-update-pr · installed: npx auto-pr-create-or-update-pr
 */

import { Duration, Effect, FileSystem, Option, Schedule } from "effect";
import {
	AutoPrPlatformLayer,
	BodyFileNotFoundError,
	ChildProcessSpawnerLayer,
	CreateOrUpdatePrConfig,
	CreateOrUpdatePrConfigLayer,
	type FileSystemError,
	isTransientGhError,
	mapFsError,
	PullRequestClient,
	type PullRequestFailedError,
	runMain,
} from "#auto-pr";
import type { PrLookupError, PrUrlParseError } from "#core/errors.js";

// ─── Constants ────────────────────────────────────────────────────────────

const GH_RETRY_ATTEMPTS = 3;
const GH_RETRY_DELAY_MS = 5000;

function formatRetryDelay(delay: Duration.Duration): string {
	const delayMs = Duration.toMillis(delay);
	return delayMs >= 1000 ? `${delayMs / 1000}s` : `${delayMs}ms`;
}

function createGhRetrySchedule(
	branch: string,
	delay: Duration.Duration = Duration.millis(GH_RETRY_DELAY_MS),
) {
	const delayLabel = formatRetryDelay(delay);
	return Schedule.recurs(GH_RETRY_ATTEMPTS - 1).pipe(
		Schedule.addDelay(() =>
			Effect.logWarning({
				event: "create_or_update_pr",
				status: "gh_retry",
				branch,
				message: `gh failed, retrying in about ${delayLabel}...`,
			}).pipe(Effect.as(delay)),
		),
		// Effect v4 jitter keeps the delay within 80%-120%, so the log remains approximate.
		Schedule.jittered,
	);
}

function runGhWithRetry<R, E, A>(
	effect: Effect.Effect<A, E, R>,
	branch: string,
	retryDelay?: Duration.Duration,
): Effect.Effect<A, E, R> {
	return effect.pipe(
		Effect.retry({
			schedule: createGhRetrySchedule(branch, retryDelay),
			while: (error: E) => isTransientGhError(error),
		}),
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

type CreateOrUpdatePrError =
	| PullRequestFailedError
	| BodyFileNotFoundError
	| FileSystemError
	| PrLookupError
	| PrUrlParseError;

/** Main pipeline. Exported for tests. */
export function runCreateOrUpdatePr(params: {
	branch: string;
	defaultBranch: string;
	title: string;
	bodyFile: string;
	workspace: string;
	retryDelay?: Duration.Duration;
}): Effect.Effect<void, CreateOrUpdatePrError, PullRequestClient | FileSystem.FileSystem> {
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const prClient = yield* PullRequestClient;
		const bodyExists = yield* fs
			.exists(params.bodyFile)
			.pipe(mapFsError(params.bodyFile, "exists"));
		if (!bodyExists) {
			return yield* Effect.fail(new BodyFileNotFoundError({ path: params.bodyFile }));
		}

		const prInfo = yield* runGhWithRetry(
			prClient.findByBranch(params.branch),
			params.branch,
			params.retryDelay,
		);
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
			yield* runGhWithRetry(
				prClient.update(prNumber, params.title, params.bodyFile),
				params.branch,
				params.retryDelay,
			);
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
			const url = yield* runGhWithRetry(
				prClient.create(params.branch, params.defaultBranch, params.title, params.bodyFile),
				params.branch,
				params.retryDelay,
			);
			yield* Effect.log({
				event: "create_or_update_pr",
				status: "created",
				url,
				branch: params.branch,
			});
		}
	});
}

// ─── Entry ──────────────────────────────────────────────────────────────────

const program = Effect.gen(function* () {
	const params = yield* CreateOrUpdatePrConfig;
	yield* runCreateOrUpdatePr(params).pipe(Effect.provide(PullRequestClient.Live(params.workspace)));
}).pipe(
	Effect.provide(CreateOrUpdatePrConfigLayer),
	Effect.provide(AutoPrPlatformLayer),
	Effect.provide(ChildProcessSpawnerLayer),
);

if (import.meta.main) {
	runMain(program, "create_or_update_pr_failed");
}
