/**
 * Scenario: local model with reliable tool-call support → real AI generation, no fallback.
 *
 * Uses Qwen3-1.7B Q4_K_M via llama-server (`--jinja`) in Testcontainers + `.github/llama-ci/Dockerfile`.
 *
 * Run via `integration-local` CI job (see .github/workflows/integration.yml).
 * Requires Docker. Set `INTEGRATION_SKIP_DOCKER=1` to skip.
 */
import { describe, expect, test } from "bun:test";
import { Duration, Effect } from "effect";
import { generatePrContent } from "#workflow/auto-pr-generate-content.js";
import { layerLocal, PR_DESCRIPTION_PROMISE, TEMPLATE } from "./helpers.js";
import { acquireLlamaLocalContainer, FsPath } from "./llama-local-container.js";

const DEFAULT_QWEN_MODEL_URL =
	"https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF/resolve/main/Qwen_Qwen3-1.7B-Q4_K_M.gguf";

const skipDocker = process.env.INTEGRATION_SKIP_DOCKER === "1";

describe.skipIf(skipDocker)("integration: local llama.cpp (qwen3-1.7b, happy path)", () => {
	test(
		"generatePrContent (2 commits) uses AI and produces non-fallback PR body",
		async () => {
			const modelUrl = new URL(
				process.env.INTEGRATION_LLAMA_MODEL_URL?.trim() || DEFAULT_QWEN_MODEL_URL,
			);
			const cacheRaw = process.env.INTEGRATION_MODEL_CACHE?.trim();
			const modelCacheDir =
				cacheRaw !== undefined && cacheRaw.length > 0 ? FsPath(cacheRaw) : undefined;
			const descriptionPromptText = await PR_DESCRIPTION_PROMISE;
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const { openAiCompatBaseUrl, modelId } = yield* acquireLlamaLocalContainer({
							modelUrl,
							modelCacheDir,
							extraLlamaArgs: ["--jinja"],
						});
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
		{ timeout: 300_000 },
	);
});
