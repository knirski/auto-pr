/**
 * Shared fixtures and layer builders for AI provider integration tests.
 *
 * Three scenarios (one file each):
 *   - ai-providers.local-fallback   stub model (no tool calls) → commit-summary fallback path
 *   - ai-providers.github-models    GitHub Models (phi-4-mini) → real AI generation via cloud
 *   - ai-providers.local-happy      full model (`INTEGRATION_LLAMA_MODEL_URL`, `--jinja`) → real AI via local llama
 */
import { Effect, Layer, Redacted } from "effect";
import { aiProviderLayerFromConfig, DiffToolkit, GitContext } from "#auto-pr";
import { createGitContextMock, TestBaseLayer } from "#test/test-utils.js";

export const PR_DESCRIPTION_PROMISE = Bun.file(
	new URL("../../src/auto-pr/prompts/pr-description.txt", import.meta.url),
).text();

const TWO_COMMITS = `---COMMIT---
feat: add module A

Adds A.
---COMMIT---
fix: fix bug in B

Fixes B.
`;

const FILES = "src/a.ts\nsrc/b.ts\n";
const DIFF_STAT = " src/a.ts | 5 +++++\n src/b.ts | 3 +++\n 2 files changed, 8 insertions(+)";
export const TEMPLATE = "# PR\n\n{{description}}\n\n## Changes\n{{changes}}";

const MockDiffToolkitLayer = DiffToolkit.toLayer(
	Effect.succeed(
		DiffToolkit.of({
			get_diff: () => Effect.succeed(""),
			get_commit_diff: () => Effect.succeed(""),
		}),
	),
);

function makeGitContextLayer(): Layer.Layer<GitContext> {
	const ctx = createGitContextMock({
		getLog: () => Effect.succeed(TWO_COMMITS),
		getChangedFiles: () => Effect.succeed(FILES),
		getDiffStat: () => Effect.succeed(DIFF_STAT),
	});
	return Layer.succeed(GitContext, ctx);
}

export function layerLocal(model: string, openaiCompatUrl: URL) {
	const openaiCompatUrlStr = openaiCompatUrl.href.replace(/\/$/, "");
	return Layer.mergeAll(
		TestBaseLayer,
		aiProviderLayerFromConfig({
			provider: "local",
			model,
			openaiCompatUrl: openaiCompatUrlStr,
		}),
		makeGitContextLayer(),
		MockDiffToolkitLayer,
	);
}

export function layerGithubModels(model: string, ghToken: string) {
	return Layer.mergeAll(
		TestBaseLayer,
		aiProviderLayerFromConfig({
			provider: "github-models",
			model,
			ghToken: Redacted.make(ghToken),
		}),
		makeGitContextLayer(),
		MockDiffToolkitLayer,
	);
}
