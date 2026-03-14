import { Result } from "effect";
import { describe, expect, test } from "vitest";
import {
	buildDescriptionPrompt,
	filterSemanticSubjects,
	formatGhOutput,
	isBlank,
	isMergeCommitSubject,
	parseSubjects,
	sanitizeForGhOutput,
	trimOllamaResponse,
	validateDescriptionResponse,
} from "../../../scripts/auto-pr/index.js";

describe("auto-pr core", () => {
	describe("isMergeCommitSubject", () => {
		test("matches merge commit", () => {
			expect(isMergeCommitSubject("Merge branch 'main' into feature")).toBe(true);
			expect(isMergeCommitSubject("merge pull request #1")).toBe(true);
		});
		test("rejects non-merge", () => {
			expect(isMergeCommitSubject("feat: add foo")).toBe(false);
			expect(isMergeCommitSubject("fix: bar")).toBe(false);
		});
	});

	describe("filterSemanticSubjects", () => {
		test("filters merge and blank", () => {
			const input = ["feat: a", "Merge branch 'x'", "", "  ", "fix: b"];
			expect(filterSemanticSubjects(input)).toEqual(["feat: a", "fix: b"]);
		});
		test("returns empty for all merge/blank", () => {
			expect(filterSemanticSubjects(["Merge x", "", "  "])).toEqual([]);
		});
	});

	describe("formatGhOutput", () => {
		test("formats key=value lines with trailing newline", () => {
			const entries = [
				{ key: "a", value: "1" },
				{ key: "b", value: "2" },
			];
			expect(formatGhOutput(entries)).toBe("a=1\nb=2\n");
		});
	});

	describe("sanitizeForGhOutput", () => {
		test("escapes percent, CR, newline", () => {
			expect(sanitizeForGhOutput("a%b\nc\rd")).toBe("a%25b%0Ac%0Dd");
		});
		test("trims and slices to 72", () => {
			expect(sanitizeForGhOutput("  x  ")).toBe("x");
			expect(sanitizeForGhOutput("a".repeat(100)).length).toBe(72);
		});
	});

	describe("isBlank", () => {
		test("true for empty and whitespace", () => {
			expect(isBlank("")).toBe(true);
			expect(isBlank("   ")).toBe(true);
			expect(isBlank("\t\n")).toBe(true);
		});
		test("false for content", () => {
			expect(isBlank("x")).toBe(false);
			expect(isBlank("  x  ")).toBe(false);
		});
	});

	describe("parseSubjects", () => {
		test("splits and filters", () => {
			expect(parseSubjects("a\n\nb\n  c  ")).toEqual(["a", "b", "c"]);
		});
	});

	describe("trimOllamaResponse", () => {
		test("trims quotes and whitespace", () => {
			expect(trimOllamaResponse('"hello"')).toBe("hello");
			expect(trimOllamaResponse("  x  ")).toBe("x");
		});
	});

	describe("buildDescriptionPrompt", () => {
		test("builds prompt with content", () => {
			const out = buildDescriptionPrompt("Desc template", "commit content");
			expect(out).toContain("Desc template");
			expect(out).toContain("commit content");
		});
	});

	describe("validateDescriptionResponse", () => {
		test("succeeds for non-empty", () => {
			Result.match(validateDescriptionResponse("some text"), {
				onSuccess: (v) => expect(v).toBe("some text"),
				onFailure: () => expect.fail("expected success"),
			});
		});
		test("fails for empty", () => {
			Result.match(validateDescriptionResponse(""), {
				onSuccess: () => expect.fail("expected failure"),
				onFailure: () => {},
			});
			Result.match(validateDescriptionResponse("null"), {
				onSuccess: () => expect.fail("expected failure"),
				onFailure: () => {},
			});
		});
	});
});
