#!/usr/bin/env node

import { A as CreateOrUpdatePrConfigLayer, U as mapFsError, a as runCommand, k as CreateOrUpdatePrConfig, n as ChildProcessSpawnerLayer, o as runMain, r as PlatformLayer, t as AutoPrLoggerLayer, z as BodyFileNotFoundError } from "../auto-pr-gJsKsYcH.mjs";
import { Duration, Effect, FileSystem, Option, Schedule, Schema } from "effect";
//#region src/workflow/create-or-update-pr.ts
/**
* Create or update a PR. Thin gh wrapper.
*
* Requires env: GH_TOKEN, BRANCH, DEFAULT_BRANCH, TITLE, BODY_FILE
*
* Validates required env at startup, then calls gh pr view --json → gh pr edit or gh pr create.
* Uses --json number,url for reliable PR existence check (avoids exit-code ambiguity).
* Uses PR number for edits (more robust than branch name). Uses --head for create (CI-safe).
*
* Run: npx tsx src/workflow/create-or-update-pr.ts (or: node dist/workflow/create-or-update-pr.mjs)
*/
const GH_RETRY_ATTEMPTS = 3;
const GH_RETRY_DELAY_MS = 5e3;
const PrInfoSchema = Schema.Struct({
	number: Schema.Number,
	url: Schema.String.pipe(Schema.check(Schema.isMinLength(1)))
});
/** Reliable PR existence check: gh pr view --json number,url. Returns Option with PR info if exists. */
function ghPrViewJson(branch, cwd) {
	return Effect.gen(function* () {
		const trimmed = (yield* runCommand("gh", [
			"pr",
			"view",
			branch,
			"--json",
			"number,url"
		], cwd)).trim();
		if (!trimmed) return Option.none();
		const parsed = yield* Effect.try({
			try: () => JSON.parse(trimmed),
			catch: () => null
		}).pipe(Effect.catch(() => Effect.succeed(null)));
		if (parsed === null) return Option.none();
		return yield* Schema.decodeUnknownEffect(PrInfoSchema)(parsed).pipe(Effect.map(Option.some), Effect.catch(() => Effect.succeed(Option.none())));
	}).pipe(Effect.catch(() => Effect.succeed(Option.none())));
}
function ghPrEdit(prNumber, title, bodyPath, cwd) {
	return runCommand("gh", [
		"pr",
		"edit",
		String(prNumber),
		"--title",
		title,
		"--body-file",
		bodyPath
	], cwd);
}
function ghPrCreate(headBranch, baseBranch, title, bodyPath, cwd) {
	return runCommand("gh", [
		"pr",
		"create",
		"--head",
		headBranch,
		"--base",
		baseBranch,
		"--title",
		title,
		"--body-file",
		bodyPath
	], cwd);
}
function createGhRetrySchedule(branch) {
	return Schedule.recurs(GH_RETRY_ATTEMPTS - 1).pipe(Schedule.addDelay(() => Effect.logWarning({
		event: "create_or_update_pr",
		status: "gh_retry",
		branch,
		message: "gh failed, retrying in 5s..."
	}).pipe(Effect.as(Duration.millis(GH_RETRY_DELAY_MS)))));
}
function runGhWithRetry(effect, branch) {
	return effect.pipe(Effect.retry(createGhRetrySchedule(branch)), Effect.tapError(() => Effect.logError({
		event: "create_or_update_pr",
		status: "failed_after_retries",
		branch,
		message: "gh pr failed after 3 attempts"
	})));
}
function extractPrUrl(stdout) {
	return stdout.trim().split("\n").at(-1) ?? "";
}
/** Main pipeline. Exported for tests. */
function runCreateOrUpdatePr(params) {
	return Effect.gen(function* () {
		if (!(yield* (yield* FileSystem.FileSystem).exists(params.bodyFile).pipe(mapFsError(params.bodyFile, "exists")))) return yield* Effect.fail(new BodyFileNotFoundError({ path: params.bodyFile }));
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
				titlePreview: params.title.slice(0, 50)
			});
			yield* runGhWithRetry(ghPrEdit(prNumber, params.title, params.bodyFile, cwd), params.branch);
			yield* Effect.log({
				event: "create_or_update_pr",
				status: "updated",
				url,
				branch: params.branch
			});
		} else {
			yield* Effect.log({
				event: "create_or_update_pr",
				status: "creating",
				head: params.branch,
				base: params.defaultBranch,
				titlePreview: params.title.slice(0, 50)
			});
			const url = extractPrUrl(yield* runGhWithRetry(ghPrCreate(params.branch, params.defaultBranch, params.title, params.bodyFile, cwd), params.branch));
			if (url) yield* Effect.log({
				event: "create_or_update_pr",
				status: "created",
				url,
				branch: params.branch
			});
		}
	});
}
const program = Effect.gen(function* () {
	yield* runCreateOrUpdatePr(yield* CreateOrUpdatePrConfig);
}).pipe(Effect.provide(CreateOrUpdatePrConfigLayer), Effect.provide(PlatformLayer), Effect.provide(ChildProcessSpawnerLayer), Effect.provide(AutoPrLoggerLayer));
if (import.meta.main) runMain(program, "create_or_update_pr_failed");
//#endregion
export { runCreateOrUpdatePr };

//# sourceMappingURL=create-or-update-pr.mjs.map