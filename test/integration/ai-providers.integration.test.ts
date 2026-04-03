/**
 * Real HTTP integration tests for AI providers. Disabled unless env flags are set
 * (see `.github/workflows/integration.yml`). Normal `bun test` skips these via describe.skipIf.
 * CI runs with `bun --config=bunfig.integration.toml` so coverage threshold from the main bunfig
 * does not fail narrow integration-only runs.
 *
 * Exercises `generatePrContentFromValues` (same orchestration as production) with real providers.
 * Production uses `generateText` + JSON parse (not `generateObject`). Local llama may still reject some
 * OpenAI-compat request shapes or return unusable JSON; the pipeline retries and may fall back — we assert a coherent PR-shaped result.
 */
import { describe, expect, test } from "bun:test";
import { Duration, Effect, Layer, Redacted } from "effect";
import { aiProviderLayerFromConfig } from "#auto-pr";
import { runEffect } from "#test/run-effect.js";
import { TestBaseLayer } from "#test/test-utils.js";
import { generatePrContentFromValues } from "#workflow/auto-pr-generate-content.js";

const runLocal = process.env.AUTO_PR_INTEGRATION_LOCAL === "1";
const runGithubModels = process.env.AUTO_PR_INTEGRATION_GITHUB_MODELS === "1";

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
const TEMPLATE = "# PR\n\n{{description}}\n\n## Changes\n{{changes}}";

function layerGithubModels(model: string, ghToken: string) {
	return Layer.mergeAll(
		TestBaseLayer,
		aiProviderLayerFromConfig({
			provider: "github-models",
			model,
			ghToken: Redacted.make(ghToken),
		}),
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
	);
}

describe.skipIf(!runLocal)("integration: local OpenAI-compat (llama.cpp)", () => {
	test(
		"generatePrContentFromValues (2 commits) completes with PR-shaped body",
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
					const result = yield* generatePrContentFromValues({
						commitsContent: TWO_COMMITS,
						filesContent: FILES,
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

describe.skipIf(!runGithubModels)("integration: github-models", () => {
	test(
		"generatePrContentFromValues (2 commits) returns title and structured description",
		async () => {
			const model = process.env.AUTO_PR_AI_OPENAI_COMPAT_MODEL ?? "microsoft/phi-4-mini-instruct";
			const token = process.env.GH_TOKEN;
			if (token === undefined || token === "") {
				throw new Error("GH_TOKEN is required for github-models integration");
			}
			const descriptionPromptText = await PR_DESCRIPTION_PROMISE;
			const layer = layerGithubModels(model, token);
			await runEffect(layer)(
				Effect.gen(function* () {
					const result = yield* generatePrContentFromValues({
						commitsContent: TWO_COMMITS,
						filesContent: FILES,
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
