/**
 * Real HTTP integration tests for AI providers. Disabled unless env flags are set
 * (see `.github/workflows/integration.yml`). Normal `bun test` skips these via describe.skipIf.
 * CI runs with `bun --config=bunfig.integration.toml` so coverage threshold from the main bunfig
 * does not fail narrow integration-only runs.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Layer, Redacted, Schema } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { aiProviderLayerFromConfig } from "#auto-pr";
import { runEffect } from "#test/run-effect.js";
import { TestBaseLayer } from "#test/test-utils.js";

const runLocal = process.env.AUTO_PR_INTEGRATION_LOCAL === "1";
const runGithubModels = process.env.AUTO_PR_INTEGRATION_GITHUB_MODELS === "1";

/** Minimal JSON shape to verify GitHub Models (see github-models describe block). */
const SmokeObjectSchema = Schema.Struct({
	word: Schema.String,
});

function parseFirstJsonObject(text: string): unknown {
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		const match = trimmed.match(/\{[\s\S]*\}/u);
		if (match === null) {
			throw new Error("integration: no JSON object in model output");
		}
		return JSON.parse(match[0]) as unknown;
	}
}

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

describe.skipIf(!runLocal)("integration: local OpenAI-compat (llama.cpp)", () => {
	test(
		"OpenAI-compatible /models lists the loaded model (smoke; avoids chat/completions 400 on pinned llama-server)",
		async () => {
			const baseUrl = process.env.AUTO_PR_AI_OPENAI_COMPAT_URL;
			const model = process.env.AUTO_PR_AI_OPENAI_COMPAT_MODEL;
			if (baseUrl === undefined || baseUrl === "") {
				throw new Error("AUTO_PR_AI_OPENAI_COMPAT_URL is required for local integration");
			}
			if (model === undefined || model === "") {
				throw new Error("AUTO_PR_AI_OPENAI_COMPAT_MODEL is required for local integration");
			}
			// Pinned llama-server builds can return HTTP 400 `_Map_base::at` for POST /chat/completions
			// even with a minimal body; CI only needs to verify the server is up and advertises the model.
			const modelsUrl = `${baseUrl.replace(/\/$/, "")}/models`;
			const res = await fetch(modelsUrl);
			const raw = await res.text();
			if (!res.ok) {
				throw new Error(`integration local llama: GET ${modelsUrl} HTTP ${res.status}: ${raw}`);
			}
			const json = JSON.parse(raw) as {
				data?: ReadonlyArray<{ id?: string }>;
			};
			const ids = (json.data ?? []).map((e) => e.id).filter(Boolean);
			expect(ids.length).toBeGreaterThan(0);
			expect(ids).toContain(model);
		},
		{ timeout: 180_000 },
	);
});

// GitHub Models (`models.github.ai`) rejects `response_format.type: json_schema` (HTTP 422); it only
// allows `text` or `json_object`. `LanguageModel.generateObject` via `@effect/ai-openai-compat` always
// emits OpenAI-style `json_schema` structured output, so it fails here. We use `generateText` + parse
// until Effect exposes a `json_object` (non-schema) path for structured output on such APIs — likely
// an upstream gap / bug for non-OpenAI OpenAI-compatible endpoints.
describe.skipIf(!runGithubModels)("integration: github-models", () => {
	test(
		"generateText returns JSON we can decode (GitHub Models allows text/json_object response_format only)",
		async () => {
			const model = process.env.AUTO_PR_AI_OPENAI_COMPAT_MODEL ?? "microsoft/phi-4-mini-instruct";
			const token = process.env.GH_TOKEN;
			if (token === undefined || token === "") {
				throw new Error("GH_TOKEN is required for github-models integration");
			}
			const layer = layerGithubModels(model, token);
			await runEffect(layer)(
				Effect.gen(function* () {
					const res = yield* LanguageModel.generateText({
						prompt:
							'Reply with a single JSON object only (no markdown fences, no extra text). The object must have one string field "word" with value "pong".',
					});
					const parsed = parseFirstJsonObject(res.text);
					const decoded = yield* Schema.decodeUnknownEffect(SmokeObjectSchema)(parsed);
					expect(decoded.word.toLowerCase()).toContain("pong");
				}),
			);
		},
		{ timeout: 180_000 },
	);
});
