/**
 * Scenario: cloud AI provider (GitHub Models) → real AI generation, tool calls, JSON parse.
 *
 * Uses microsoft/phi-4-mini-instruct via GitHub Models API. Exercises the full
 * happy path: tool calls, structured JSON output, schema validation.
 *
 * Run via `integration-github-models` CI job (see .github/workflows/integration.yml).
 * Requires: GH_TOKEN (models: read)
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { runEffect } from "#test/run-effect.js";
import { generatePrContent } from "#workflow/auto-pr-generate-content.js";
import { layerGithubModels, PR_DESCRIPTION_PROMISE, TEMPLATE } from "./helpers.js";

const canRun = (process.env.GH_TOKEN ?? "").trim() !== "";

describe.skipIf(!canRun)("integration: github-models", () => {
	test(
		"generatePrContent (2 commits) returns title and structured description",
		async () => {
			const model = process.env.INTEGRATION_GITHUB_MODEL?.trim() || "microsoft/phi-4-mini-instruct";
			const token = process.env.GH_TOKEN ?? "";
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
