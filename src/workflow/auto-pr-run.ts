/**
 * Run the auto-PR pipeline locally (no GitHub Actions).
 * Requires: DEFAULT_BRANCH, GITHUB_WORKSPACE, PR_TEMPLATE_PATH, GH_TOKEN, OLLAMA_MODEL, OLLAMA_URL.
 * For 2+ commits: Ollama must be running (default: localhost:11434).
 *
 * Run: npx tsx src/workflow/auto-pr-run.ts (or: node dist/workflow/auto-pr-run.js)
 */

import { Effect, FileSystem, Layer } from "effect";
import * as Http from "effect/unstable/http";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { PullRequestFailedError } from "#auto-pr";
import {
	AutoPrLoggerLayer,
	AutoPrPlatformLayer,
	ChildProcessSpawnerLayer,
	FillPrTemplate,
	parseGhOutput,
	RunAutoPrConfig,
	RunAutoPrConfigLayer,
	runCommand,
	runMain,
	validateGenerateContentOutput,
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
	Http.FetchHttpClient.layer,
);

function runPipeline(): Effect.Effect<void, unknown, never> {
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const config = yield* RunAutoPrConfig;
		const { workspace, defaultBranch, templatePath, branch, model, ollamaUrl, howToTestDefault } =
			config;
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
			ghOutput,
			workspace,
			templatePath,
			model,
			ollamaUrl,
			howToTestDefault,
		});

		const content2 = yield* fs.readFileString(ghOutput);
		const parsed2 = parseGhOutput(content2);
		const { title, bodyFile } = yield* Effect.fromResult(validateGenerateContentOutput(parsed2));

		yield* Effect.log({ event: "run_auto_pr", step: "create_or_update_pr" });
		yield* runCreateOrUpdatePr({
			branch: branchVal,
			defaultBranch,
			title,
			bodyFile,
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
