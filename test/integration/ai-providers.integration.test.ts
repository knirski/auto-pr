/**
 * Real HTTP integration tests for AI providers. Excluded from default `bun test` via
 * `pathIgnorePatterns` in `bunfig.toml`. Use `bun run test:integration`.
 *
 * Each suite runs only when its prerequisites are set (OpenAI-compat URL + model for local;
 * `GH_TOKEN` for GitHub Models). CI sets all of them in one job and runs both.
 *
 * Uses `bun --config=bunfig.integration.toml` in CI so coverage threshold from the main bunfig
 * does not fail narrow integration-only runs.
 *
 * Exercises `generatePrContent` (same orchestration as production) with real providers.
 * Production uses `generateText` + JSON parse (not `generateObject`). Local llama may still reject some
 * OpenAI-compat request shapes or return unusable JSON; the pipeline retries and may fall back — we assert a coherent PR-shaped result.
 *
 * Two-tier CI strategy (intentional):
 *   - Local llama (tiny-llama.gguf, ~27 KiB) — a Mozilla smoke-test stub with no tool-call support.
 *     Expected to fail the AI call and exercise the commit-summary fallback path. Verifies the
 *     pipeline handles model errors gracefully and still produces a coherent PR body.
 *   - GitHub Models (phi-4-mini-instruct) — exercises the real AI generation path (tool calls,
 *     JSON parse, schema validation). This is the only provider that tests actual AI output.
 * Replacing tiny-llama with a real model is intentionally avoided: the fallback path needs its own
 * test, and real AI quality is already covered by GitHub Models.
 */
import { describe, expect, test } from "bun:test";
import { Duration, Effect, Layer, Redacted } from "effect";
import { aiProviderLayerFromConfig, DiffToolkit, GitContext } from "#auto-pr";
import { runEffect } from "#test/run-effect.js";
import { createGitContextMock, TestBaseLayer } from "#test/test-utils.js";
import { generatePrContent } from "#workflow/auto-pr-generate-content.js";

function envNonEmpty(name: string): boolean {
	const v = process.env[name];
	return v !== undefined && v.trim() !== "";
}

/** Local OpenAI-compat: URL and model id (from llama-server or your server). */
const canRunLocal =
	envNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_URL") && envNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_MODEL");

/** Qwen2.5-1.5B happy-path suite: separate env vars set only by the integration-qwen CI job. */
const canRunQwen =
	envNonEmpty("AUTO_PR_AI_QWEN_COMPAT_URL") && envNonEmpty("AUTO_PR_AI_QWEN_COMPAT_MODEL");

/** GitHub Models: token with `models: read` (e.g. `GITHUB_TOKEN` in Actions). */
const canRunGithubModels = envNonEmpty("GH_TOKEN");

const PR_DESCRIPTION_PROMISE = Bun.file(
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
const TEMPLATE = "# PR\n\n{{description}}\n\n## Changes\n{{changes}}";

/** Mock DiffToolkit handler layer — tools return empty strings (never called by mock AI). */
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

function layerGithubModels(model: string, ghToken: string) {
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

function layerLocal(model: string, openaiCompatUrl: string) {
	return Layer.mergeAll(
		TestBaseLayer,
		aiProviderLayerFromConfig({
			provider: "local",
			model,
			openaiCompatUrl,
		}),
		makeGitContextLayer(),
		MockDiffToolkitLayer,
	);
}

describe.skipIf(!canRunLocal)("integration: local OpenAI-compat (llama.cpp)", () => {
	test(
		"generatePrContent (2 commits) completes with PR-shaped body",
		async () => {
			const baseUrl = process.env.AUTO_PR_AI_OPENAI_COMPAT_URL;
			const model = process.env.AUTO_PR_AI_OPENAI_COMPAT_MODEL;
			if (baseUrl === undefined || baseUrl === "") {
				throw new Error("AUTO_PR_AI_OPENAI_COMPAT_URL is required for local integration");
			}
			if (model === undefined || model === "") {
				throw new Error("AUTO_PR_AI_OPENAI_COMPAT_MODEL is required for local integration");
			}
			const descriptionPromptText = await PR_DESCRIPTION_PROMISE;
			const layer = layerLocal(model, baseUrl.replace(/\/$/, ""));
			await runEffect(layer)(
				Effect.gen(function* () {
					const result = yield* generatePrContent({
						baseRef: "origin/main",
						headRef: "ai/test",
						templateContent: TEMPLATE,
						descriptionPromptText,
						provider: "local",
						model,
						retryDelay: Duration.zero,
					});
					expect(result.count).toBe(2);
					expect(result.title.trim().length).toBeGreaterThan(0);
					expect(result.body).toContain("### Motivation");
					expect(result.body).toContain("### Risks");
				}),
			);
		},
		{ timeout: 180_000 },
	);
});

describe.skipIf(!canRunQwen)("integration: local llama.cpp (qwen2.5-1.5b, happy path)", () => {
	test(
		"generatePrContent (2 commits) uses AI and produces non-fallback PR body",
		async () => {
			const baseUrl = process.env.AUTO_PR_AI_QWEN_COMPAT_URL ?? "";
			const model = process.env.AUTO_PR_AI_QWEN_COMPAT_MODEL ?? "";
			const descriptionPromptText = await PR_DESCRIPTION_PROMISE;
			const layer = layerLocal(model, baseUrl.replace(/\/$/, ""));
			await runEffect(layer)(
				Effect.gen(function* () {
					const result = yield* generatePrContent({
						baseRef: "origin/main",
						headRef: "ai/test",
						templateContent: TEMPLATE,
						descriptionPromptText,
						provider: "local",
						model,
						retryDelay: Duration.zero,
					});
					expect(result.count).toBe(2);
					expect(result.title.trim().length).toBeGreaterThan(0);
					expect(result.body).toContain("### Motivation");
					expect(result.body).toContain("### Risks");
					// Qwen2.5-1.5B supports tool calls — AI generation should succeed, no fallback.
					expect(result.body).not.toContain("AI description unavailable");
				}),
			);
		},
		{ timeout: 180_000 },
	);
});

describe.skipIf(!canRunGithubModels)("integration: github-models", () => {
	test(
		"generatePrContent (2 commits) returns title and structured description",
		async () => {
			const model = process.env.INTEGRATION_GITHUB_MODEL?.trim() || "microsoft/phi-4-mini-instruct";
			const token = process.env.GH_TOKEN;
			if (token === undefined || token === "") {
				throw new Error("GH_TOKEN is required for github-models integration");
			}
			const descriptionPromptText = await PR_DESCRIPTION_PROMISE;
			const layer = layerGithubModels(model, token);
			await runEffect(layer)(
				Effect.gen(function* () {
					const result = yield* generatePrContent({
						baseRef: "origin/main",
						headRef: "ai/test",
						templateContent: TEMPLATE,
						descriptionPromptText,
						provider: "github-models",
						model,
					});
					expect(result.count).toBe(2);
					expect(result.title.trim().length).toBeGreaterThan(0);
					expect(result.body).toContain("### Motivation");
					expect(result.body).toContain("### Risks");
				}),
			);
		},
		{ timeout: 180_000 },
	);
});
