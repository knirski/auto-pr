import { describe, expect, test } from "bun:test";
import { Result } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import { type ParsedJsonObject, parseFirstJsonObject } from "#core/parse-model-json.js";

/** Plain JSON object values (not array, not null) — matches `parseFirstJsonObject` success domain. */
const jsonObjectArbitrary = FastCheck.jsonValue({ depthSize: "small" })
	.filter((v) => typeof v === "object" && v !== null && !Array.isArray(v))
	.map((v) => v as ParsedJsonObject);

/** Same structural value as `parseFirstJsonObject` / `JSON.parse` will produce (e.g. `-0` → `0`). */
function jsonRoundTrip(obj: ParsedJsonObject): ParsedJsonObject {
	return JSON.parse(JSON.stringify(obj)) as ParsedJsonObject;
}

describe("parseFirstJsonObject", () => {
	test("parses plain JSON object", () => {
		const r = parseFirstJsonObject('{"a":1}');
		expect(Result.isSuccess(r)).toBe(true);
		if (Result.isSuccess(r)) {
			expect(r.success).toEqual({ a: 1 });
		}
	});

	test("extracts first object from prose", () => {
		const r = parseFirstJsonObject(
			'Here:\n{"title":"x","motivation":"m","risks":[],"notesForReviewers":""}\n',
		);
		expect(Result.isSuccess(r)).toBe(true);
		if (Result.isSuccess(r)) {
			expect(r.success).toEqual({
				title: "x",
				motivation: "m",
				risks: [],
				notesForReviewers: "",
			});
		}
	});

	test("fails when no object", () => {
		const r = parseFirstJsonObject("no json");
		expect(Result.isFailure(r)).toBe(true);
	});

	test("PBT: round-trips JSON.stringify for plain objects", () => {
		FastCheck.assert(
			FastCheck.property(jsonObjectArbitrary, (obj) => {
				const text = JSON.stringify(obj);
				const expected = jsonRoundTrip(obj);
				const r = parseFirstJsonObject(text);
				expect(Result.isSuccess(r)).toBe(true);
				if (Result.isSuccess(r)) {
					expect(r.success).toEqual(expected);
				}
			}),
			{ numRuns: 100 },
		);
	});

	test("PBT: extracts object when wrapped in fixed prose", () => {
		FastCheck.assert(
			FastCheck.property(jsonObjectArbitrary, (obj) => {
				const text = `Here:\n${JSON.stringify(obj)}\n`;
				const expected = jsonRoundTrip(obj);
				const r = parseFirstJsonObject(text);
				expect(Result.isSuccess(r)).toBe(true);
				if (Result.isSuccess(r)) {
					expect(r.success).toEqual(expected);
				}
			}),
			{ numRuns: 100 },
		);
	});

	// JSON objects use ASCII U+007B `{`; other “brace” code points are out of scope for this property.
	test("PBT: fails when input has no ASCII `{` (no JSON object literal)", () => {
		FastCheck.assert(
			FastCheck.property(
				FastCheck.string().filter((s) => !s.includes("{")),
				(s) => {
					const r = parseFirstJsonObject(s);
					expect(Result.isFailure(r)).toBe(true);
				},
			),
			{ numRuns: 100 },
		);
	});
});
