/**
 * Extract a single JSON object from model output (plain JSON or text containing `{...}`).
 * Pure synchronous logic: no `Effect` programs and no I/O. Uses `Result` / `Option` from Effect as data only.
 * Used when APIs reject OpenAI `json_schema` response_format (e.g. GitHub Models).
 */

import { Match, Option, pipe, Result, type Schema } from "effect";
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

type JsonStringScanState =
	| { readonly _tag: "OutsideString" }
	| { readonly _tag: "InsideString"; readonly escaped: boolean };

const OutsideString: JsonStringScanState = { _tag: "OutsideString" };
const InsideStringUnescaped: JsonStringScanState = { _tag: "InsideString", escaped: false };
const InsideStringEscaped: JsonStringScanState = { _tag: "InsideString", escaped: true };

function nextJsonStringScanState(
	state: JsonStringScanState,
	ch: string | undefined,
): JsonStringScanState {
	return Match.value(state).pipe(
		Match.when({ _tag: "OutsideString" }, () => (ch === '"' ? InsideStringUnescaped : state)),
		Match.when({ _tag: "InsideString" }, (insideStringState) => {
			if (insideStringState.escaped) return InsideStringUnescaped;
			if (ch === "\\") return InsideStringEscaped;
			return ch === '"' ? OutsideString : insideStringState;
		}),
		Match.exhaustive,
	);
}

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

/** First balanced `{`…`}` span, ignoring braces inside JSON strings. */
function firstBraceSlice(text: string): Option.Option<string> {
	for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
		let depth = 0;
		let stringState = OutsideString;
		for (let i = start; i < text.length; i += 1) {
			const ch = text[i];
			const wasOutsideString = stringState._tag === "OutsideString";
			stringState = nextJsonStringScanState(stringState, ch);
			if (!wasOutsideString || ch === '"') {
				continue;
			}

			if (ch === "{") {
				depth += 1;
				continue;
			}
			if (ch === "}") {
				depth -= 1;
				if (depth === 0) {
					return Option.some(text.slice(start, i + 1));
				}
			}
		}
	}
	return Option.none();
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
