/**
 * Create or update a PR. Thin gh wrapper.
 *
 * Requires env: GH_TOKEN, BRANCH, DEFAULT_BRANCH, TITLE, BODY_FILE
 *
 * Validates required env at startup, then calls gh pr view → gh pr edit or gh pr create.
 *
 * Run: npx tsx src/workflow/create-or-update-pr.ts
 */

import { Duration, Effect, FileSystem, Schedule } from "effect";
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

// ─── Shell (Effect) ───────────────────────────────────────────────────────

function ghPrView(branch: string, cwd: string): Effect.Effect<boolean, never, ChildProcessSpawner> {
	return runCommand("gh", ["pr", "view", branch], cwd).pipe(
		Effect.as(true),
		Effect.catch(() => Effect.succeed(false)),
	);
}

function ghPrEdit(
	branch: string,
	title: string,
	bodyPath: string,
	cwd: string,
): Effect.Effect<void, PullRequestFailedError, ChildProcessSpawner> {
	return runCommand("gh", ["pr", "edit", branch, "--title", title, "--body-file", bodyPath], cwd);
}

function ghPrCreate(
	baseBranch: string,
	title: string,
	bodyPath: string,
	cwd: string,
): Effect.Effect<void, PullRequestFailedError, ChildProcessSpawner> {
	return runCommand(
		"gh",
		["pr", "create", "--base", baseBranch, "--title", title, "--body-file", bodyPath],
		cwd,
	);
}

const ghRetrySchedule = Schedule.recurs(GH_RETRY_ATTEMPTS - 1).pipe(
	Schedule.addDelay(() =>
		Effect.logWarning({
			event: "create_or_update_pr",
			status: "gh_retry",
			message: "gh failed, retrying in 5s...",
		}).pipe(Effect.as(Duration.millis(GH_RETRY_DELAY_MS))),
	),
);

function runGhWithRetry<R, E>(effect: Effect.Effect<void, E, R>): Effect.Effect<void, E, R> {
	return effect.pipe(
		Effect.retry(ghRetrySchedule),
		Effect.tapError(() =>
			Effect.logError({
				event: "create_or_update_pr",
				status: "failed_after_retries",
				message: "gh pr failed after 3 attempts",
			}),
		),
	);
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

		const prExists = yield* ghPrView(params.branch, cwd);
		if (prExists) {
			yield* Effect.log({ event: "create_or_update_pr", status: "updating" });
			yield* runGhWithRetry(ghPrEdit(params.branch, params.title, params.bodyFile, cwd));
		} else {
			yield* Effect.log({ event: "create_or_update_pr", status: "creating" });
			yield* runGhWithRetry(ghPrCreate(params.defaultBranch, params.title, params.bodyFile, cwd));
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
