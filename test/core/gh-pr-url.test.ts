import { expect, test } from "bun:test";
import { Result } from "effect";
import { parseGhPrCreateOutput } from "#core/gh-pr-url.js";

test("parses single-line URL", () => {
	const r = parseGhPrCreateOutput("https://github.com/o/r/pull/42\n");
	expect(Result.isSuccess(r)).toBe(true);
	if (Result.isSuccess(r)) expect(r.success).toBe("https://github.com/o/r/pull/42");
});

test("parses last non-empty line from multi-line gh output", () => {
	const r = parseGhPrCreateOutput(
		"Creating pull request for ai/foo into main\n\nhttps://github.com/o/r/pull/7\n",
	);
	expect(Result.isSuccess(r)).toBe(true);
	if (Result.isSuccess(r)) expect(r.success).toBe("https://github.com/o/r/pull/7");
});

test("rejects empty output", () => {
	expect(Result.isFailure(parseGhPrCreateOutput(""))).toBe(true);
	expect(Result.isFailure(parseGhPrCreateOutput("   \n\n"))).toBe(true);
});

test("rejects when last line is not a PR URL", () => {
	expect(Result.isFailure(parseGhPrCreateOutput("done"))).toBe(true);
	expect(Result.isFailure(parseGhPrCreateOutput("https://github.com/o/r/issues/1"))).toBe(true);
});

test("trims whitespace on URL line", () => {
	const r = parseGhPrCreateOutput("  https://github.com/o/r/pull/5  \n");
	expect(Result.isSuccess(r)).toBe(true);
	if (Result.isSuccess(r)) expect(r.success).toBe("https://github.com/o/r/pull/5");
});
