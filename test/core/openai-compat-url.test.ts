import { expect, test } from "bun:test";
import { Result } from "effect";
import { parseOpenAiCompatUrl } from "#core/openai-compat-url.js";

test("accepts http://host:port/v1", () => {
	expect(Result.isSuccess(parseOpenAiCompatUrl("http://127.0.0.1:8080/v1"))).toBe(true);
});

test("accepts https URL", () => {
	expect(Result.isSuccess(parseOpenAiCompatUrl("https://api.example.com/v1"))).toBe(true);
});

test("trims surrounding whitespace on success", () => {
	const r = parseOpenAiCompatUrl("  http://127.0.0.1:8080/v1  ");
	expect(Result.isSuccess(r)).toBe(true);
	if (Result.isSuccess(r)) expect(r.success).toBe("http://127.0.0.1:8080/v1");
});

test("rejects empty", () => {
	expect(Result.isFailure(parseOpenAiCompatUrl(""))).toBe(true);
});

test("rejects whitespace-only", () => {
	expect(Result.isFailure(parseOpenAiCompatUrl("   "))).toBe(true);
});

test("rejects missing scheme", () => {
	expect(Result.isFailure(parseOpenAiCompatUrl("localhost:8080"))).toBe(true);
});

test("rejects string that is not a valid URL", () => {
	const r = parseOpenAiCompatUrl(":::");
	expect(Result.isFailure(r)).toBe(true);
	if (Result.isFailure(r)) expect(r.failure.reason).toBe("not a valid URL");
});

test("rejects non-http scheme", () => {
	expect(Result.isFailure(parseOpenAiCompatUrl("ftp://example.com/v1"))).toBe(true);
});

test("error carries a human-readable reason", () => {
	const r = parseOpenAiCompatUrl("localhost:8080");
	expect(Result.isFailure(r)).toBe(true);
	if (Result.isFailure(r)) expect(typeof r.failure.reason).toBe("string");
});
