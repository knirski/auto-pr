/**
 * Run the auto-PR pipeline locally (no GitHub Actions).
 * Requires: DEFAULT_BRANCH, GITHUB_WORKSPACE, GH_TOKEN. PR template: `.github/PULL_REQUEST_TEMPLATE.md` under workspace.
 * For 2+ commits: AUTO_PR_AI_PROVIDER (optional; default ollama), AUTO_PR_AI_OLLAMA_MODEL (optional when provider is ollama). AI provider must be running (Ollama: localhost:11434).
 *
 * Run: npx tsx src/workflow/auto-pr-run.ts (or: node dist/workflow/auto-pr-run.js)
 */

import { join } from "node:path";
import { Effect, FileSystem, Layer } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { PullRequestFailedError } from "#auto-pr";
import {
	AutoPrLoggerLayer,
	AutoPrPlatformLayer,
	ChildProcessSpawnerLayer,
	FillPrTemplate,
	PR_BODY_FILE_NAME,
	PR_TITLE_FILE_NAME,
	parseGhOutput,
	RunAutoPrConfig,
	RunAutoPrConfigLayer,
	runCommand,
	runMain,
	validateGetCommitsOutput,
} from "#auto-pr";
import { runCreateOrUpdatePr } from "#workflow/auto-pr-create-or-update-pr.js";
import { runGeneratePrContent } from "#workflow/auto-pr-generate-content.js";
import { runAutoPrGetCommits } from "#workflow/auto-pr-get-commits.js";

// ─── Pipeline ────────────────────────────────────────────────────────────────

const RunAutoPrLayer = Layer.mergeAll(
	AutoPrPlatformLayer,
	ChildProcessSpawnerLayer,
	FillPrTemplate.Live,
);

function runPipeline(): Effect.Effect<void, unknown, never> {
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const config = yield* RunAutoPrConfig;
		const { workspace, defaultBranch, templatePath, branch, provider, model } = config;
		const resolvedBranch =
			branch !== undefined ? Effect.succeed(branch) : getCurrentBranch(workspace);
		const branchVal = yield* resolvedBranch;

		const ghOutput = yield* fs.makeTempFile();

		yield* Effect.log({ event: "run_auto_pr", step: "get_commits" });
		yield* runAutoPrGetCommits(defaultBranch, workspace, ghOutput);

		const content1 = yield* fs.readFileString(ghOutput);
		const parsed1 = parseGhOutput(content1);
		const { commits, files } = yield* Effect.fromResult(validateGetCommitsOutput(parsed1));

		yield* Effect.log({ event: "run_auto_pr", step: "generate_content" });
		yield* runGeneratePrContent({
			commits,
			files,
			workspace,
			templatePath,
			provider,
			model,
			...(provider === "github-models" ? { ghToken: config.ghToken } : {}),
			...(provider === "openai-compat"
				? {
						openaiCompatUrl: config.openaiCompatUrl,
						openaiCompatApiKey: config.openaiCompatApiKey,
						openaiCompatModel: config.openaiCompatModel,
					}
				: {}),
		});

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
