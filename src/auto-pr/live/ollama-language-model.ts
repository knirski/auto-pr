/**
 * Ollama adapter for Effect LanguageModel.
 * Uses the official ollama package. Supports format: "json" for structured output.
 *
 * When streamText uses responseFormat.type === "json", the full JSON response is one text-delta;
 * caller must parse it. No timeout by default; configure via custom fetch if needed.
 */

import { Effect, Layer, Match, Option, pipe, Stream } from "effect";
import { AiError, LanguageModel, type Response } from "effect/unstable/ai";
import { Ollama } from "ollama";
import { AiProviderError } from "#auto-pr/errors.js";
import { unknownToMessage } from "#auto-pr/utils.js";

const DEFAULT_OLLAMA_HOST = "http://localhost:11434";

function makeUsage(
	promptEvalCount: number,
	evalCount: number,
): Response.FinishPartEncoded["usage"] {
	return {
		inputTokens: {
			uncached: undefined,
			total: promptEvalCount,
			cacheRead: undefined,
			cacheWrite: undefined,
		},
		outputTokens: {
			total: evalCount,
			text: undefined,
			reasoning: undefined,
		},
	};
}

function makeFinishPartEncoded(
	usage: Response.FinishPartEncoded["usage"],
): Response.FinishPartEncoded {
	return {
		type: "finish",
		reason: "stop",
		usage,
		response: undefined,
	};
}

const finishPart = (
	text: string,
	usage: Response.FinishPartEncoded["usage"],
): [Response.TextPartEncoded, Response.FinishPartEncoded] => [
	{ type: "text", text },
	makeFinishPartEncoded(usage),
];

/** Extract prompt text from Effect Prompt for Ollama's simple prompt format. Ignores assistant messages. */
function promptToOllamaString(prompt: LanguageModel.ProviderOptions["prompt"]): string {
	return prompt.content
		.flatMap((message) => {
			if (message.role === "system") return [String(message.content)];
			if (message.role !== "user") return [];
			const content = message.content;
			if (typeof content === "string") return [content];
			return content.filter((part) => part.type === "text").map((part) => part.text);
		})
		.join("\n\n");
}

/** Map failures to AiError for LanguageModel contract. */
function toAiError(e: unknown, method: "generateText" | "streamText"): AiError.AiError {
	return Match.value(e).pipe(
		Match.when(
			(x: unknown): x is AiProviderError => x instanceof AiProviderError,
			(err) =>
				AiError.make({
					module: "Ollama",
					method,
					reason:
						typeof err.cause === "string" && err.cause.includes("500")
							? new AiError.InternalProviderError({ description: err.cause })
							: new AiError.UnknownError({ description: err.cause }),
				}),
		),
		Match.orElse((err) =>
			AiError.make({
				module: "Ollama",
				method,
				reason: new AiError.UnknownError({
					description: unknownToMessage(err),
				}),
			}),
		),
	);
}

/** Call Ollama generate API. Uses official ollama package. */
function callOllama(
	ollama: Ollama,
	model: string,
	promptText: string,
	useJson: boolean,
	method: "generateText" | "streamText",
): Effect.Effect<{ text: string; promptEvalCount: number; evalCount: number }, AiError.AiError> {
	const toErr = (e: unknown) => toAiError(e, method);
	return Effect.tryPromise({
		try: () =>
			ollama.generate({
				model,
				prompt: promptText,
				stream: false,
				...(useJson && { format: "json" }),
			}),
		catch: toErr,
	}).pipe(
		Effect.flatMap((res) =>
			pipe(
				Option.fromUndefinedOr(res.response?.trim()),
				Option.filter((s) => s.length > 0),
				Option.match({
					onNone: () =>
						Effect.fail(
							toErr(new AiProviderError({ cause: "Ollama response is absent or empty" })),
						),
					onSome: (text) =>
						Effect.succeed({
							text,
							promptEvalCount: res.prompt_eval_count,
							evalCount: res.eval_count,
						}),
				}),
			),
		),
	);
}

/**
 * Create Ollama LanguageModel layer.
 *
 * @param model - Model name (e.g. llama3.1:8b)
 * @param options - Optional host (default http://localhost:11434) and fetch (for tests).
 */
export function ollamaLanguageModelLayer(
	model: string,
	options?: { host?: string; fetch?: typeof fetch },
): Layer.Layer<LanguageModel.LanguageModel, never> {
	const host = (options?.host ?? DEFAULT_OLLAMA_HOST).replace(/\/$/, "");
	const ollama = new Ollama(
		options?.fetch !== undefined ? { host, fetch: options.fetch } : { host },
	);
	const service = LanguageModel.make({
		generateText: (opts: LanguageModel.ProviderOptions) =>
			callOllama(
				ollama,
				model,
				promptToOllamaString(opts.prompt),
				opts.responseFormat.type === "json",
				"generateText",
			).pipe(
				Effect.map(({ text, promptEvalCount, evalCount }) =>
					finishPart(text, makeUsage(promptEvalCount, evalCount)),
				),
			),
		streamText: (opts: LanguageModel.ProviderOptions) =>
			callOllama(
				ollama,
				model,
				promptToOllamaString(opts.prompt),
				opts.responseFormat.type === "json",
				"streamText",
			).pipe(
				Effect.map(({ text, promptEvalCount, evalCount }) =>
					Stream.fromIterable([
						{
							type: "text-delta" as const,
							id: "ollama-text",
							delta: text,
						},
						makeFinishPartEncoded(makeUsage(promptEvalCount, evalCount)),
					]),
				),
				Stream.unwrap,
			),
	});
	return Layer.effect(LanguageModel.LanguageModel, service);
}
