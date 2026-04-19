/**
 * Run the auto-PR pipeline locally (no GitHub Actions).
 * Requires: DEFAULT_BRANCH, GITHUB_WORKSPACE, GH_TOKEN. PR template: `.github/PULL_REQUEST_TEMPLATE.md` under workspace.
 * For 2+ commits: `AUTO_PR_AI_PROVIDER` (optional; default `local`) and provider-specific env (see `config.ts`). For `local`, run an OpenAI-compatible server (e.g. llama.cpp `llama-server`) at `AUTO_PR_AI_OPENAI_COMPAT_URL` (default `http://127.0.0.1:8080/v1`).
 *
 * This repo: bun run run-auto-pr · installed: npx auto-pr-run
 */

import { join } from "node:path";
import { Effect, FileSystem, Layer } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { PullRequestFailedError } from "#auto-pr";
import {
	AutoPrLoggerLayer,
	AutoPrPlatformLayer,
	ChildProcessSpawnerLayer,
	type CliMainEffect,
	FillPrTemplate,
	PR_BODY_FILE_NAME,
	PR_TITLE_FILE_NAME,
	RunAutoPrConfig,
	RunAutoPrConfigLayer,
	runCommand,
	runMain,
} from "#auto-pr";
import { runCreateOrUpdatePr } from "#workflow/auto-pr-create-or-update-pr.js";
import { runGeneratePrContent } from "#workflow/auto-pr-generate-content.js";

// ─── Pipeline ────────────────────────────────────────────────────────────────

const RunAutoPrLayer = Layer.mergeAll(
	AutoPrPlatformLayer,
	ChildProcessSpawnerLayer,
	FillPrTemplate.Live,
);

function runPipeline(): CliMainEffect {
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const config = yield* RunAutoPrConfig;
		const { workspace, defaultBranch, templatePath, model } = config;
		const branchVal = yield* config.branch !== undefined
			? Effect.succeed(config.branch)
			: getCurrentBranch(workspace);

		yield* Effect.log({ event: "run_auto_pr", step: "generate_content" });
		yield* runGeneratePrContent(
			config.provider === "github-models"
				? {
						defaultBranch,
						branch: branchVal,
						workspace,
						templatePath,
						provider: "github-models",
						model,
						ghToken: config.ghToken,
					}
				: {
						defaultBranch,
						branch: branchVal,
						workspace,
						templatePath,
						provider: "local",
						model,
						openaiCompatUrl: config.openaiCompatUrl,
						...(config.openaiCompatApiKey !== undefined
							? { openaiCompatApiKey: config.openaiCompatApiKey }
							: {}),
					},
		);

		const titlePath = join(workspace, PR_TITLE_FILE_NAME);
		const bodyPath = join(workspace, PR_BODY_FILE_NAME);
		const title = (yield* fs.readFileString(titlePath)).trim();

		yield* Effect.log({ event: "run_auto_pr", step: "create_or_update_pr" });
		yield* runCreateOrUpdatePr({
			branch: branchVal,
			defaultBranch,
			title,
			bodyFile: bodyPath,
			workspace,
		});

		yield* Effect.log({ event: "run_auto_pr", status: "done" });
	}).pipe(
		Effect.provide(RunAutoPrLayer),
		Effect.provide(RunAutoPrConfigLayer),
		Effect.provide(AutoPrLoggerLayer),
	);
}

function getCurrentBranch(
	cwd: string,
): Effect.Effect<string, PullRequestFailedError, ChildProcessSpawner> {
	return runCommand("git", ["branch", "--show-current"], cwd);
}

// ─── Entry ───────────────────────────────────────────────────────────────────

if (import.meta.main) {
	runMain(runPipeline(), "run_auto_pr_failed");
}
