/**
 * Scenario: local model with reliable tool-call support → real AI generation, no fallback.
 *
 * Uses Qwen3-1.7B Q4_K_M via llama.cpp with --jinja (required for Qwen3 chat template).
 * Tool-call reliability: 0.960 — at 5 retries, P(all fail) ≈ 0.0001%.
 * Asserts that AI output is used directly (no "AI description unavailable" fallback marker).
 *
 * Run via `integration-local-happy` CI job (see .github/workflows/integration.yml).
 * Requires: AUTO_PR_AI_OPENAI_COMPAT_URL, AUTO_PR_AI_OPENAI_COMPAT_MODEL
 */
import { describe, expect, test } from "bun:test";
import { Duration, Effect } from "effect";
import { runEffect } from "#test/run-effect.js";
import { generatePrContent } from "#workflow/auto-pr-generate-content.js";
import { layerLocal, PR_DESCRIPTION_PROMISE, TEMPLATE } from "./helpers.js";

const canRun =
	(process.env.AUTO_PR_AI_OPENAI_COMPAT_URL ?? "").trim() !== "" &&
	(process.env.AUTO_PR_AI_OPENAI_COMPAT_MODEL ?? "").trim() !== "";

describe.skipIf(!canRun)("integration: local llama.cpp (qwen3-1.7b, happy path)", () => {
	test(
		"generatePrContent (2 commits) uses AI and produces non-fallback PR body",
		async () => {
			const baseUrl = process.env.AUTO_PR_AI_OPENAI_COMPAT_URL ?? "";
			const model = process.env.AUTO_PR_AI_OPENAI_COMPAT_MODEL ?? "";
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
					// Qwen3-1.7B has 0.960 tool-call reliability — AI generation should succeed, no fallback.
					expect(result.body).not.toContain("AI description unavailable");
				}),
			);
		},
		{ timeout: 180_000 },
	);
});
