/**
 * Scenario: local full model with tool-call support → real AI generation, no fallback.
 *
 * In CI, uses the llama-server already started by `.github/actions/llama-server-docker-start`.
 * Locally, falls back to `INTEGRATION_LLAMA_MODEL_URL` from env (`.env.ci`) via Testcontainers + `.github/llama-server/Dockerfile`.
 *
 * Run via `integration-local` CI job (see .github/workflows/integration.yml).
 * Requires Docker. Set `INTEGRATION_SKIP_DOCKER=1` to skip.
 */
import { describe, expect, test } from "bun:test";
import { Duration, Effect } from "effect";
import { generatePrContent } from "#workflow/auto-pr-generate-content.js";
import {
  layerLocal,
  localLlamaEndpointFromEnv,
  PR_DESCRIPTION_PROMISE,
  TEMPLATE,
} from "./helpers.js";
import { requireIntegrationEnv } from "./integration-env.js";
import { acquireLlamaLocalContainer, FsPath } from "./llama-local-container.js";

const skipDocker = process.env.INTEGRATION_SKIP_DOCKER === "1";

describe.skipIf(skipDocker)("integration: local llama.cpp (model, happy path)", () => {
  test(
    "generatePrContent (2 commits) uses AI and produces non-fallback PR body",
    async () => {
      const descriptionPromptText = await PR_DESCRIPTION_PROMISE;
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const configuredEndpoint = localLlamaEndpointFromEnv();
            const { openAiCompatBaseUrl, modelId } =
              configuredEndpoint ??
              (yield* Effect.gen(function* () {
                const modelUrl = new URL(requireIntegrationEnv("INTEGRATION_LLAMA_MODEL_URL"));
                const cacheRaw = process.env.INTEGRATION_MODEL_CACHE?.trim();
                const modelCacheDir =
                  cacheRaw !== undefined && cacheRaw.length > 0 ? FsPath(cacheRaw) : undefined;
                return yield* acquireLlamaLocalContainer({
                  modelUrl,
                  modelCacheDir,
                  extraLlamaArgs: ["--jinja"],
                });
              }));
            const layer = layerLocal(modelId, openAiCompatBaseUrl);
            yield* Effect.provide(
              generatePrContent({
                baseRef: "origin/main",
                headRef: "ai/test",
                templateContent: TEMPLATE,
                descriptionPromptText,
                provider: "local",
                model: modelId,
                retryDelay: Duration.zero,
              }),
              layer,
            ).pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  expect(result.count).toBe(2);
                  expect(result.title.trim().length).toBeGreaterThan(0);
                  expect(result.body).toContain("### Motivation");
                  expect(result.body).toContain("### Risks");
                  expect(result.body).not.toContain("AI description unavailable");
                }),
              ),
            );
          }),
        ),
      );
    },
    {
      // act-local-ci: full GGUF on CPU often exceeds 5 min; hosted CI is typically faster.
      timeout: process.env.AUTO_PR_ACT_LOCAL_CI === "1" ? 900_000 : 300_000,
    },
  );
});
