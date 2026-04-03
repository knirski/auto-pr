/**
 * Opt-in integration smoke tests: real HTTP to OpenAI-compatible backends (weak assertions by design).
 * Strong behavior is covered by mocked tests in `test/workflow/generate-pr-content.test.ts`.
 *
 * ## Local (llama.cpp)
 *
 * Set `AUTO_PR_INTEGRATION_LOCAL=1`. Requires **Docker** for Testcontainers unless you point at an existing server.
 *
 * - **Testcontainers** (default): starts pinned `llama.cpp` image with vendored `test/integration/fixtures/tiny-llama.gguf`.
 *   The fixture is tiny; `generateObject` may occasionally flake — re-run if needed.
 * - **Explicit URL:** `AUTO_PR_AI_OPENAI_COMPAT_URL=http://127.0.0.1:8080/v1` — no Docker for the test process.
 *
 * Optional: `AUTO_PR_AI_OPENAI_COMPAT_MODEL` (default `gpt-oss` for local).
 *
 * ## GitHub Models
 *
 * Set `AUTO_PR_INTEGRATION_GITHUB_MODELS=1` and a non-empty **`GH_TOKEN`** with `models:read`.
 * If the flag is set without a token, this block is **skipped** (not failed).
 * Uses quota / rate limits on your GitHub account. In CI, `GH_TOKEN` is set from `github.token` (see `check.yml`).
 *
 * Model is fixed to `microsoft/phi-4-mini-instruct` for cost/smoke stability.
 *
 * Run: `bun run test:integration` (see `package.json`). **CI:** `.github/workflows/check-integration.yml`
 * sets `AUTO_PR_INTEGRATION_*` and `GH_TOKEN`; must pass with `check` for merges (see `docs/CI.md`).
 */
import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Redacted } from "effect";
import { aiProviderLayerFromConfig } from "#auto-pr/live/ai-provider.js";
import {
	LlamacppTestContainer,
	OPENAI_MODELS_READY_MAX_MS,
	waitForOpenAiModelsEndpoint,
} from "#test/integration/llamacpp-testcontainer.js";
import { SilentLoggerLayer, TestBaseLayer } from "#test/test-utils.js";
import { generatePrContentFromValues } from "#workflow/auto-pr-generate-content.js";

const BaseLayer = Layer.mergeAll(TestBaseLayer, SilentLoggerLayer);

/** Align with production `RETRY_DELAY_MS` — tiny GGUF may need full backoff between AI retries. */
const INTEGRATION_RETRY_DELAY_MS = 3000;

function logContent(...blocks: Array<{ subject: string; body: string }>): string {
	const formatted = blocks.map((b) => (b.body ? `${b.subject}\n\n${b.body}`.trim() : b.subject));
	return `---COMMIT---\n${formatted.join("\n---COMMIT---\n")}`;
}

/** Same layering as `runEffect`, but failed exits throw with `Cause.pretty` for CI logs. */
async function runIntegrationEffect<A, E, R, EL>(
	layer: Layer.Layer<R, EL, never>,
	effect: Effect.Effect<A, E, R>,
): Promise<A> {
	const exit = await Effect.runPromiseExit(Effect.provide(effect.pipe(Effect.scoped), layer));
	if (Exit.isSuccess(exit)) {
		return exit.value;
	}
	throw new Error(`integration effect failed:\n${Cause.pretty(exit.cause)}`);
}

const runLocalIntegration = process.env.AUTO_PR_INTEGRATION_LOCAL === "1";
const runGithubIntegration = process.env.AUTO_PR_INTEGRATION_GITHUB_MODELS === "1";
const hasGithubModelsToken =
	process.env.GH_TOKEN !== undefined && process.env.GH_TOKEN.trim() !== "";

/** Fixed for GitHub Models integration (low-cost catalog id). */
const GITHUB_MODELS_INTEGRATION_MODEL = "microsoft/phi-4-mini-instruct";

function requireGithubTokenForIntegration(): string {
	const raw = process.env.GH_TOKEN;
	if (raw === undefined || raw.trim() === "") {
		throw new Error("GH_TOKEN required (describe should skip this suite when unset)");
	}
	return raw;
}

describe.skipIf(!runLocalIntegration)("integration: local OpenAI-compat (llama.cpp)", () => {
	test(
		"generatePrContentFromValues completes for 2+ commits",
		async () => {
			const explicit = process.env.AUTO_PR_AI_OPENAI_COMPAT_URL?.trim();
			const model = process.env.AUTO_PR_AI_OPENAI_COMPAT_MODEL ?? "gpt-oss";

			const layer = explicit
				? Layer.mergeAll(
						BaseLayer,
						aiProviderLayerFromConfig({
							provider: "local",
							model,
							openaiCompatUrl: explicit,
						}),
					)
				: Layer.mergeAll(BaseLayer, LlamacppTestContainer.layerAiProvider(model));

			const result = await runIntegrationEffect(
				layer,
				Effect.gen(function* () {
					if (explicit) {
						yield* Effect.promise(() =>
							waitForOpenAiModelsEndpoint(explicit, OPENAI_MODELS_READY_MAX_MS),
						);
					}
					return yield* generatePrContentFromValues({
						commitsContent: logContent(
							{ subject: "feat: add auth", body: "JWT validation for API routes." },
							{ subject: "fix: handle edge case", body: "Empty token handling." },
						),
						filesContent: "src/auth.ts\n",
						templateContent: "# PR\n\n{{description}}",
						descriptionPromptText:
							"Summarize these commits. Return JSON with title and description.",
						provider: "local",
						model,
						retryDelayMs: INTEGRATION_RETRY_DELAY_MS,
					});
				}),
			);

			expect(result.count).toBe(2);
			expect(result.title.trim().length).toBeGreaterThan(0);
			expect(result.body.length).toBeGreaterThan(0);
		},
		{ timeout: 700_000 },
	);
});

describe.skipIf(!runGithubIntegration || !hasGithubModelsToken)(
	"integration: GitHub Models API",
	() => {
		test(
			"generatePrContentFromValues completes for 2+ commits",
			async () => {
				const raw = requireGithubTokenForIntegration();
				const model = GITHUB_MODELS_INTEGRATION_MODEL;

				const layer = Layer.mergeAll(
					BaseLayer,
					aiProviderLayerFromConfig({
						provider: "github-models",
						model,
						ghToken: Redacted.make(raw, { label: "GH_TOKEN" }),
					}),
				);

				const result = await runIntegrationEffect(
					layer,
					generatePrContentFromValues({
						commitsContent: logContent(
							{ subject: "feat: add metrics", body: "Prometheus counters." },
							{ subject: "docs: update readme", body: "Installation steps." },
						),
						filesContent: "src/metrics.ts\n",
						templateContent: "# PR\n\n{{description}}",
						descriptionPromptText:
							"Summarize these commits. Return JSON with title and description.",
						provider: "github-models",
						model,
						retryDelayMs: INTEGRATION_RETRY_DELAY_MS,
					}),
				);

				expect(result.count).toBe(2);
				expect(result.title.trim().length).toBeGreaterThan(0);
				expect(result.body.length).toBeGreaterThan(0);
			},
			{ timeout: 300_000 },
		);
	},
);
