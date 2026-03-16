#!/usr/bin/env node

import { C as parseGhOutput, D as validateGenerateContentOutput, L as RunAutoPrConfig, O as validateGetCommitsOutput, R as RunAutoPrConfigLayer, a as runCommand, c as FillPrTemplate, n as ChildProcessSpawnerLayer, o as runMain, r as PlatformLayer, t as AutoPrLoggerLayer } from "../auto-pr-gJsKsYcH.mjs";
import { runAutoPrGetCommits } from "./auto-pr-get-commits.mjs";
import { runGeneratePrContent } from "./generate-pr-content.mjs";
import { runCreateOrUpdatePr } from "./create-or-update-pr.mjs";
import { Effect, FileSystem, Layer } from "effect";
import * as Http from "effect/unstable/http";
//#region src/workflow/run-auto-pr.ts
/**
* Run the auto-PR pipeline locally (no GitHub Actions).
* Requires: DEFAULT_BRANCH, GITHUB_WORKSPACE, PR_TEMPLATE_PATH, GH_TOKEN, OLLAMA_MODEL, OLLAMA_URL.
* For 2+ commits: Ollama must be running (default: localhost:11434).
*
* Run: npx tsx src/workflow/run-auto-pr.ts (or: node dist/workflow/run-auto-pr.mjs)
*/
const RunAutoPrLayer = Layer.mergeAll(PlatformLayer, ChildProcessSpawnerLayer, FillPrTemplate.Live, Http.FetchHttpClient.layer);
function runPipeline() {
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const { workspace, defaultBranch, templatePath, branch, model, ollamaUrl, howToTestDefault } = yield* RunAutoPrConfig;
		const branchVal = yield* branch !== void 0 ? Effect.succeed(branch) : getCurrentBranch(workspace);
		const ghOutput = yield* fs.makeTempFile();
		yield* Effect.log({
			event: "run_auto_pr",
			step: "get_commits"
		});
		yield* runAutoPrGetCommits(defaultBranch, workspace, ghOutput);
		const parsed1 = parseGhOutput(yield* fs.readFileString(ghOutput));
		const { commits, files } = yield* Effect.fromResult(validateGetCommitsOutput(parsed1));
		yield* Effect.log({
			event: "run_auto_pr",
			step: "generate_content"
		});
		yield* runGeneratePrContent({
			commits,
			files,
			ghOutput,
			workspace,
			templatePath,
			model,
			ollamaUrl,
			howToTestDefault
		});
		const parsed2 = parseGhOutput(yield* fs.readFileString(ghOutput));
		const { title, bodyFile } = yield* Effect.fromResult(validateGenerateContentOutput(parsed2));
		yield* Effect.log({
			event: "run_auto_pr",
			step: "create_or_update_pr"
		});
		yield* runCreateOrUpdatePr({
			branch: branchVal,
			defaultBranch,
			title,
			bodyFile,
			workspace
		});
		yield* Effect.log({
			event: "run_auto_pr",
			status: "done"
		});
	}).pipe(Effect.provide(RunAutoPrLayer), Effect.provide(RunAutoPrConfigLayer), Effect.provide(AutoPrLoggerLayer));
}
function getCurrentBranch(cwd) {
	return runCommand("git", ["branch", "--show-current"], cwd);
}
if (import.meta.main) runMain(runPipeline(), "run_auto_pr_failed");
//#endregion
export {};

//# sourceMappingURL=run-auto-pr.mjs.map