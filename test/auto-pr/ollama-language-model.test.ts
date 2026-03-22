import { describe, expect, test } from "bun:test";
import { Effect, Layer, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { ollamaLanguageModelLayer } from "#auto-pr/live/ollama-language-model.js";
import { runEffect } from "#test/run-effect.js";
import {
	createOllamaMockFetch,
	type OllamaMockResponses,
	SilentLoggerLayer,
	TestBaseLayer,
} from "#test/test-utils.js";

const mockResponse = "feat: add X\n\nOllama-generated summary.";

function testLayer(responses: OllamaMockResponses) {
	return Layer.mergeAll(
		TestBaseLayer,
		SilentLoggerLayer,
		ollamaLanguageModelLayer("llama3.1:8b", {
			host: "http://test",
			fetch: createOllamaMockFetch(responses),
		}),
	);
}

describe("ollamaLanguageModelLayer", () => {
	test("generateText returns text from Ollama response", async () => {
		await runEffect(testLayer(mockResponse))(
			Effect.gen(function* () {
				const response = yield* LanguageModel.generateText({
					prompt: "Summarize these commits.",
				});
				expect(response.text).toBe("feat: add X\n\nOllama-generated summary.");
			}).pipe(Effect.scoped),
		);
	});

	test("streamText returns stream of text delta and finish", async () => {
		await runEffect(testLayer(mockResponse))(
			Effect.gen(function* () {
				const model = yield* LanguageModel.LanguageModel;
				const stream = model.streamText({ prompt: "Say hello." });
				const chunks: string[] = [];
				yield* stream.pipe(
					Stream.runForEach((part) =>
						Effect.sync(() => {
							if (part.type === "text-delta") chunks.push(part.delta);
						}),
					),
				);
				expect(chunks.join("")).toBe("feat: add X\n\nOllama-generated summary.");
			}).pipe(Effect.scoped),
		);
	});

	test("generateText fails with AiError when Ollama returns HTTP 500", async () => {
		const layer = testLayer([{ response: "error", status: 500 }]);
		await expect(
			runEffect(layer)(
				Effect.gen(function* () {
					yield* LanguageModel.generateText({ prompt: "Hi" });
				}).pipe(Effect.scoped),
			),
		).rejects.toMatchObject({
			_tag: expect.any(String),
			module: "Ollama",
			method: "generateText",
		});
	});

	test("generateText fails when Ollama returns empty response", async () => {
		const layer = testLayer([{ response: "" }]);
		await expect(
			runEffect(layer)(
				Effect.gen(function* () {
					yield* LanguageModel.generateText({ prompt: "Hi" });
				}).pipe(Effect.scoped),
			),
		).rejects.toMatchObject({
			_tag: expect.any(String),
			module: "Ollama",
		});
	});

	test("generateText fails with UnknownError when fetch throws", async () => {
		const layer = testLayer([{ fail: "network error" }]);
		await expect(
			runEffect(layer)(
				Effect.gen(function* () {
					yield* LanguageModel.generateText({ prompt: "Hi" });
				}).pipe(Effect.scoped),
			),
		).rejects.toMatchObject({
			_tag: expect.any(String),
			module: "Ollama",
			method: "generateText",
		});
	});

	test("generateText returns usage when Ollama 0.17+ provides token counts", async () => {
		await runEffect(
			testLayer({
				response: "Hello",
				prompt_eval_count: 10,
				eval_count: 5,
			}),
		)(
			Effect.gen(function* () {
				const response = yield* LanguageModel.generateText({
					prompt: "Hi",
				});
				expect(response.text).toBe("Hello");
				expect(response.usage.inputTokens.total).toBe(10);
				expect(response.usage.outputTokens.total).toBe(5);
			}).pipe(Effect.scoped),
		);
	});

	test("generateObject with responseFormat json returns parsed value", async () => {
		const Schema = await import("effect/Schema");
		const TestSchema = Schema.Struct({ greeting: Schema.String });
		await runEffect(testLayer('{"greeting":"Hello"}'))(
			Effect.gen(function* () {
				const response = yield* LanguageModel.generateObject({
					prompt: 'Respond with JSON: {"greeting":"Hello"}',
					schema: TestSchema,
				});
				expect(response.value.greeting).toBe("Hello");
			}).pipe(Effect.scoped),
		);
	});

	test("streamText fails with AiError when Ollama returns HTTP 500", async () => {
		const layer = testLayer([{ response: "error", status: 500 }]);
		await expect(
			runEffect(layer)(
				Effect.gen(function* () {
					const model = yield* LanguageModel.LanguageModel;
					yield* model.streamText({ prompt: "Hi" }).pipe(Stream.runDrain);
				}).pipe(Effect.scoped),
			),
		).rejects.toMatchObject({
			_tag: expect.any(String),
			module: "Ollama",
			method: "streamText",
		});
	});

	test("streamText fails when Ollama returns empty response", async () => {
		const layer = testLayer([{ response: "" }]);
		await expect(
			runEffect(layer)(
				Effect.gen(function* () {
					const model = yield* LanguageModel.LanguageModel;
					yield* model.streamText({ prompt: "Hi" }).pipe(Stream.runDrain);
				}).pipe(Effect.scoped),
			),
		).rejects.toMatchObject({
			_tag: expect.any(String),
			module: "Ollama",
			method: "streamText",
		});
	});

	test("uses custom host when provided", async () => {
		const layer = Layer.mergeAll(
			TestBaseLayer,
			SilentLoggerLayer,
			ollamaLanguageModelLayer("llama3.1:8b", {
				host: "http://custom:11434",
				fetch: createOllamaMockFetch(mockResponse),
			}),
		);
		await runEffect(layer)(
			Effect.gen(function* () {
				const response = yield* LanguageModel.generateText({
					prompt: "Hi",
				});
				expect(response.text).toBe("feat: add X\n\nOllama-generated summary.");
			}).pipe(Effect.scoped),
		);
	});
});
