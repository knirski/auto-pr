/**
 * Scenario: cloud AI provider (OpenRouter) → real AI generation, tool calls, JSON parse.
 *
 * Uses `OPENROUTER_API_KEY` plus `INTEGRATION_OPENROUTER_MODEL` (from `.env.ci`, defaulting to
 * `DEFAULT_OPENROUTER_MODEL`) via the OpenRouter API. Exercises the full happy path: tool calls,
 * structured JSON output, schema validation. Skips when the API key is not set.
 *
 * Run via `integration-openrouter` CI job (see .github/workflows/integration.yml).
 * Requires: OPENROUTER_API_KEY (repo secret in CI; exported locally).
 */
import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import { DEFAULT_OPENROUTER_MODEL } from "#core/openrouter-routing.js";
import { runEffect } from "#test/run-effect.js";
import { generatePrContent } from "#workflow/auto-pr-generate-content.js";
import { layerOpenRouter, PR_DESCRIPTION_PROMISE, TEMPLATE } from "./helpers.js";

const openRouterApiKey = (process.env.OPENROUTER_API_KEY ?? "").trim();
const canRun = openRouterApiKey !== "";

describe.skipIf(!canRun)("integration: openrouter", () => {
  test(
    "generatePrContent (2 commits) returns title and structured description",
    async () => {
      const model = process.env.INTEGRATION_OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
      const descriptionPromptText = await PR_DESCRIPTION_PROMISE;
      const layer = layerOpenRouter(
        model,
        Redacted.make(openRouterApiKey, { label: "OPENROUTER_API_KEY" }),
      );
      await runEffect(layer)(
        Effect.gen(function* () {
          const result = yield* generatePrContent({
            baseRef: "origin/main",
            headRef: "ai/test",
            templateContent: TEMPLATE,
            descriptionPromptText,
            provider: "openrouter",
            model,
            allowToolCalls: true,
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
