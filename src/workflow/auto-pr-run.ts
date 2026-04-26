/**
 * Run the auto-PR pipeline locally (no GitHub Actions).
 * Requires: DEFAULT_BRANCH, GITHUB_WORKSPACE, GH_TOKEN. PR template: `.github/PULL_REQUEST_TEMPLATE.md` under workspace.
 * For 2+ commits: `AUTO_PR_AI_PROVIDER` (optional; default `local`) and provider-specific env (see `config.ts`). For `local`, run an OpenAI-compatible server (e.g. llama.cpp `llama-server`) at `AUTO_PR_AI_OPENAI_COMPAT_URL` (default `http://127.0.0.1:8080/v1`).
 *
 * This repo: bun run run-auto-pr · installed: npx auto-pr-run
 */

import { Effect, Layer } from "effect";
import {
	AutoPrLoggerLayer,
	AutoPrPlatformLayer,
	aiProviderLayerFromConfig,
	ChildProcessSpawnerLayer,
	type CliMainEffect,
	GitContextLive,
	makeDiffToolkitLayer,
	PullRequestClient,
	RunAutoPrConfig,
	RunAutoPrConfigLayer,
	type RunAutoPrConfig as RunAutoPrConfigService,
	runMain,
} from "#auto-pr";
import {
	resolveRunAutoPrBranch,
	runAutoPrPipelineWithServices,
} from "#workflow/auto-pr-run-pipeline.js";

// ─── Pipeline ────────────────────────────────────────────────────────────────

function livePipeline(config: RunAutoPrConfigService): CliMainEffect {
	const gitLayer = GitContextLive(config.workspace).pipe(Layer.provide(ChildProcessSpawnerLayer));
	const baseLayer = Layer.mergeAll(AutoPrPlatformLayer, ChildProcessSpawnerLayer, gitLayer);

	return Effect.gen(function* () {
		const branch = yield* resolveRunAutoPrBranch(config);
		const configWithBranch = { ...config, branch };
		const aiLayer = aiProviderLayerFromConfig(
			config.provider === "github-models"
				? {
						provider: "github-models",
						model: config.model,
						ghToken: config.ghToken,
					}
				: {
						provider: "local",
						model: config.model,
						openaiCompatUrl: config.openaiCompatUrl,
						...(config.openaiCompatApiKey !== undefined
							? { openaiCompatApiKey: config.openaiCompatApiKey }
							: {}),
					},
		);
		const toolkitLayer = makeDiffToolkitLayer(`origin/${config.defaultBranch}`, branch).pipe(
			Layer.provide(gitLayer),
		);
		const prClientLayer = PullRequestClient.Live(config.workspace).pipe(
			Layer.provide(ChildProcessSpawnerLayer),
		);
		yield* runAutoPrPipelineWithServices(configWithBranch).pipe(
			Effect.provide(Layer.mergeAll(baseLayer, aiLayer, toolkitLayer, prClientLayer)),
		);
	}).pipe(Effect.provide(baseLayer));
}

/* c8 ignore next 6 */
function runPipeline(): CliMainEffect {
	return Effect.gen(function* () {
		const config = yield* RunAutoPrConfig;
		yield* livePipeline(config);
	}).pipe(Effect.provide(RunAutoPrConfigLayer), Effect.provide(AutoPrLoggerLayer));
}

// ─── Entry ───────────────────────────────────────────────────────────────────

/* c8 ignore next 3 */
if (import.meta.main) {
	runMain(runPipeline(), "run_auto_pr_failed");
}
