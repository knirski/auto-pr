/**
 * Extract a single JSON object from model output (plain JSON or text containing `{...}`).
 * Pure synchronous logic: no `Effect` programs and no I/O. Uses `Result` / `Option` from Effect as data only.
 * Used when APIs reject OpenAI `json_schema` response_format (e.g. GitHub Models).
 */

import { Option, pipe, Result, type Schema } from "effect";
import { toError } from "#core/string.js";

/**
 * JSON value as returned by `JSON.parse` (Effect’s `Schema.MutableJson`: plain objects/arrays/primitives).
 * Use for untyped parses; for known shapes, decode with `Schema` or a narrow type instead.
 */
export type ParsedJson = Schema.MutableJson;

/** Plain JSON object (not array). */
export type ParsedJsonObject = Schema.MutableJsonObject;

const NOT_OBJECT = new Error("expected a JSON object");
const NO_OBJECT_IN_OUTPUT = new Error("no JSON object in model output");

function tryParseJson(text: string): Result.Result<ParsedJson, Error> {
	return Result.try({
		try: () => JSON.parse(text) as ParsedJson,
		catch: toError,
	});
}

function requireJsonObject(value: ParsedJson): Result.Result<ParsedJsonObject, Error> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Result.succeed(value)
		: Result.fail(NOT_OBJECT);
}

/** First `{`…`}` span (greedy). Not a JSON tokenizer: wrong if multiple objects or `{`/`}` inside strings need distinct spans. */
function firstBraceSlice(text: string): Option.Option<string> {
	return Option.fromNullishOr(text.match(/\{[\s\S]*\}/u)?.[0]);
}

function parseObjectFromCandidate(text: string): Result.Result<ParsedJsonObject, Error> {
	return pipe(tryParseJson(text), Result.flatMap(requireJsonObject));
}

/**
 * Parse trimmed model output: prefer a full-string JSON parse; if that does not yield a plain object,
 * parse the first `{...}` substring via {@link firstBraceSlice}.
 */
export function parseFirstJsonObject(text: string): Result.Result<ParsedJsonObject, Error> {
	const trimmed = text.trim();
	const fromFullString = parseObjectFromCandidate(trimmed);
	return pipe(
		fromFullString,
		Result.orElse(() =>
			pipe(
				firstBraceSlice(trimmed),
				Option.match({
					onNone: () => Result.fail(NO_OBJECT_IN_OUTPUT),
					onSome: parseObjectFromCandidate,
				}),
			),
		),
	);
}
