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

function envNonEmpty(name: string): boolean {
	const v = process.env[name];
	return v !== undefined && v.trim() !== "";
}

/** Local OpenAI-compat: URL and model id (from llama-server or your server). */
const canRunLocal =
	envNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_URL") && envNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_MODEL");

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

describe.skipIf(!canRunLocal)("integration: local OpenAI-compat (llama.cpp)", () => {
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

describe.skipIf(!canRunGithubModels)("integration: github-models", () => {
	test(
		"generatePrContentFromValues (2 commits) returns title and structured description",
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
