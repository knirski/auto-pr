/**
 * Create or update a PR. Thin gh wrapper.
 *
 * Requires env: GH_TOKEN, BRANCH, DEFAULT_BRANCH, TITLE, BODY_FILE
 *
 * Validates required env at startup, then calls gh pr view → gh pr edit or gh pr create.
 *
 * Run: npx tsx scripts/create-or-update-pr.ts
 */

import { Duration, Effect, FileSystem, Schedule } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import {
	AutoPrLoggerLayer,
	AutoPrPlatformLayer,
	BodyFileNotFound,
	ChildProcessSpawnerLayer,
	CreateOrUpdatePrConfig,
	CreateOrUpdatePrConfigLayer,
	type GhPrFailed,
	runCommand,
	runMain,
} from "./auto-pr/index.js";
import { type FileSystemError, mapFsError } from "./auto-pr/utils.js";

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
): Effect.Effect<void, GhPrFailed, ChildProcessSpawner> {
	return runCommand("gh", ["pr", "edit", branch, "--title", title, "--body-file", bodyPath], cwd);
}

function ghPrCreate(
	baseBranch: string,
	title: string,
	bodyPath: string,
	cwd: string,
): Effect.Effect<void, GhPrFailed, ChildProcessSpawner> {
	return runCommand(
		"gh",
		["pr", "create", "--base", baseBranch, "--title", title, "--body-file", bodyPath],
		cwd,
	);
}

const ghRetrySchedule = Schedule.recurs(GH_RETRY_ATTEMPTS - 1).pipe(
	Schedule.addDelay(() =>
		Effect.logWarning("gh failed, retrying in 5s...").pipe(
			Effect.as(Duration.millis(GH_RETRY_DELAY_MS)),
		),
	),
);

function runGhWithRetry<R, E>(effect: Effect.Effect<void, E, R>): Effect.Effect<void, E, R> {
	return effect.pipe(
		Effect.retry(ghRetrySchedule),
		Effect.tapError(() => Effect.logError("gh pr failed after 3 attempts")),
	);
}

type CreateOrUpdatePrError = GhPrFailed | BodyFileNotFound | FileSystemError;

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
			return yield* Effect.fail(new BodyFileNotFound({ path: params.bodyFile }));
		}

		const cwd = params.workspace;

		const prExists = yield* ghPrView(params.branch, cwd);
		if (prExists) {
			yield* Effect.log("PR exists, updating...");
			yield* runGhWithRetry(ghPrEdit(params.branch, params.title, params.bodyFile, cwd));
		} else {
			yield* Effect.log("Creating PR...");
			yield* runGhWithRetry(ghPrCreate(params.defaultBranch, params.title, params.bodyFile, cwd));
		}
	});
}

// ─── Entry ──────────────────────────────────────────────────────────────────

const program = Effect.gen(function* () {
	const config = yield* CreateOrUpdatePrConfig;
	const { branch, defaultBranch, title, bodyFile, workspace } = config.config;

	yield* runCreateOrUpdatePr({
		branch,
		defaultBranch,
		title,
		bodyFile,
		workspace,
	});
}).pipe(
	Effect.provide(CreateOrUpdatePrConfigLayer),
	Effect.provide(AutoPrPlatformLayer),
	Effect.provide(ChildProcessSpawnerLayer),
	Effect.provide(AutoPrLoggerLayer),
);

if (import.meta.main) {
	runMain(program, "create_or_update_pr_failed");
}
