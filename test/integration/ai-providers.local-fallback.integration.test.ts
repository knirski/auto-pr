/**
 * Scenario: local model with no tool-call support → commit-summary fallback path.
 *
 * Uses Mozilla tiny-llama (~27 KiB stub, llama.cpp). The model cannot produce
 * tool calls or valid JSON, so `generatePrContent` retries then falls back to
 * building the PR body from commit summaries. Asserts graceful fallback output.
 *
 * Run via `integration-local-fallback` CI job (see .github/workflows/integration.yml).
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

describe.skipIf(!canRun)("integration: local llama.cpp (tiny-llama, fallback path)", () => {
	test(
		"generatePrContent (2 commits) completes with PR-shaped body",
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
				}),
			);
		},
		{ timeout: 180_000 },
	);
});
