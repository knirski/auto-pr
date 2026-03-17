import { describe, expect, test } from "bun:test";
import { Result } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import {
	buildDescriptionPrompt,
	buildGenerateContentGhEntries,
	buildGetCommitsGhEntries,
	decodeGhOutputTitle,
	filterSemanticSubjects,
	formatGhOutput,
	type GhOutputValue,
	getGhOutputValue,
	isBlank,
	isHttpError,
	isMergeCommitSubject,
	parseGhOutput,
	parseSubjects,
	parseTitleDescriptionResponse,
	sanitizeForGhOutput,
	trimOllamaResponse,
	validateDescriptionResponse,
	validateGenerateContentOutput,
	validateGetCommitsOutput,
} from "#auto-pr";

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
			Result.match(sanitizeForGhOutput("a%b\nc\rd"), {
				onSuccess: (v) => expect(v).toBe("a%25b%0Ac%0Dd" as GhOutputValue),
				onFailure: () => expect().fail("expected success"),
			});
		});
		test("trims and slices to 72", () => {
			Result.match(sanitizeForGhOutput("  x  "), {
				onSuccess: (v) => expect(v).toBe("x" as GhOutputValue),
				onFailure: () => expect().fail("expected success"),
			});
			Result.match(sanitizeForGhOutput("a".repeat(100)), {
				onSuccess: (v) => expect(v.length).toBe(72),
				onFailure: () => expect().fail("expected success"),
			});
		});
		test("fails when escaped value exceeds 72 chars", () => {
			Result.match(sanitizeForGhOutput("%".repeat(72)), {
				onSuccess: () => expect().fail("expected failure"),
				onFailure: () => {},
			});
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
		test("split by newline, trim, filter blank", () => {
			FastCheck.assert(
				FastCheck.property(FastCheck.array(FastCheck.string()), (subjects) => {
					const formatted = subjects.join("\n");
					const parsed = parseSubjects(formatted);
					const expected = subjects.flatMap((s) =>
						s
							.split("\n")
							.map((l) => l.trim())
							.filter(Boolean),
					);
					expect(parsed).toEqual(expected);
				}),
			);
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
				onFailure: () => expect().fail("expected success"),
			});
		});
		test("fails for empty", () => {
			Result.match(validateDescriptionResponse(""), {
				onSuccess: () => expect().fail("expected failure"),
				onFailure: () => {},
			});
			Result.match(validateDescriptionResponse("null"), {
				onSuccess: () => expect().fail("expected failure"),
				onFailure: () => {},
			});
		});
	});

	describe("parseTitleDescriptionResponse", () => {
		test("parses title and description", () => {
			const input = "feat: add X\n\nSummary of changes here.";
			Result.match(parseTitleDescriptionResponse(input), {
				onSuccess: (v) => {
					expect(v.title).toBe("feat: add X");
					expect(v.description).toBe("Summary of changes here.");
				},
				onFailure: () => expect().fail("expected success"),
			});
		});
		test("fails for empty or null", () => {
			Result.match(parseTitleDescriptionResponse(""), {
				onSuccess: () => expect().fail("expected failure"),
				onFailure: () => {},
			});
			Result.match(parseTitleDescriptionResponse("null"), {
				onSuccess: () => expect().fail("expected failure"),
				onFailure: () => {},
			});
		});
		test("fails when title or description missing", () => {
			Result.match(parseTitleDescriptionResponse("feat: x"), {
				onSuccess: () => expect().fail("expected failure"),
				onFailure: () => {},
			});
			Result.match(parseTitleDescriptionResponse("\n\nDescription only"), {
				onSuccess: () => expect().fail("expected failure"),
				onFailure: () => {},
			});
		});
	});

	describe("parseGhOutput", () => {
		test("parses key=value lines", () => {
			const out = parseGhOutput("commits=/path/commits.txt\nfiles=/path/files.txt\n");
			expect(out).toEqual({
				commits: "/path/commits.txt",
				files: "/path/files.txt",
			});
		});
		test("ignores lines without =", () => {
			expect(parseGhOutput("invalid\nkey=val\n")).toEqual({ key: "val" });
		});
	});

	describe("getGhOutputValue", () => {
		test("returns value when key present", () => {
			const parsed = { a: "1", b: "2" };
			Result.match(getGhOutputValue(parsed, "a"), {
				onSuccess: (v) => expect(v).toBe("1"),
				onFailure: () => expect().fail("expected success"),
			});
		});
		test("fails when key absent", () => {
			const parsed = { a: "1", b: "2" };
			Result.match(getGhOutputValue(parsed, "missing"), {
				onSuccess: () => expect().fail("expected failure"),
				onFailure: (e) => expect(e.message).toContain("missing key"),
			});
		});
	});

	describe("decodeGhOutputTitle", () => {
		test("decodes URI component", () => {
			Result.match(decodeGhOutputTitle("feat%3A%20add%20x"), {
				onSuccess: (v) => expect(v).toBe("feat: add x"),
				onFailure: () => expect().fail("expected success"),
			});
		});
		test("fails when absent (blank)", () => {
			Result.match(decodeGhOutputTitle(""), {
				onSuccess: () => expect().fail("expected failure"),
				onFailure: (e) => expect(e.message).toContain("absent"),
			});
		});
		test("fails on invalid", () => {
			Result.match(decodeGhOutputTitle("%"), {
				onSuccess: () => expect().fail("expected failure"),
				onFailure: () => {},
			});
		});
	});

	describe("sanitizeForGhOutput and decodeGhOutputTitle round-trip", () => {
		test("sanitize then decode yields original for non-empty strings without special chars (≤72 chars)", () => {
			FastCheck.assert(
				FastCheck.property(
					FastCheck.string({ minLength: 1, maxLength: 72 }).filter(
						(s) => s.trim().length > 0 && !/[\n\r%]/.test(s),
					),
					(title) => {
						const sanitized = sanitizeForGhOutput(title);
						Result.match(sanitized, {
							onSuccess: (encoded) => {
								const decoded = decodeGhOutputTitle(encoded);
								Result.match(decoded, {
									onSuccess: (v) => expect(v).toBe(title.trim().slice(0, 72)),
									onFailure: () => expect().fail("decode should succeed"),
								});
							},
							onFailure: () => {},
						});
					},
				),
			);
		});
	});

	describe("validateGetCommitsOutput", () => {
		test("succeeds when commits and files present", () => {
			const r = validateGetCommitsOutput({ commits: "/c", files: "/f" });
			Result.match(r, {
				onSuccess: (v) => expect(v).toEqual({ commits: "/c", files: "/f" }),
				onFailure: () => expect().fail("expected success"),
			});
		});
		test("fails when missing", () => {
			Result.match(validateGetCommitsOutput({}), {
				onSuccess: () => expect().fail("expected failure"),
				onFailure: () => {},
			});
		});
		test("fails when commits blank", () => {
			Result.match(validateGetCommitsOutput({ commits: "  ", files: "/f" }), {
				onSuccess: () => expect().fail("expected failure"),
				onFailure: (e) => expect(e.message).toContain("commits and files"),
			});
		});
		test("fails when files blank", () => {
			Result.match(validateGetCommitsOutput({ commits: "/c", files: "" }), {
				onSuccess: () => expect().fail("expected failure"),
				onFailure: (e) => expect(e.message).toContain("commits and files"),
			});
		});
	});

	describe("validateGenerateContentOutput", () => {
		test("succeeds when title and body_file present", () => {
			const r = validateGenerateContentOutput({ title: "feat: x", body_file: "/b" });
			Result.match(r, {
				onSuccess: (v) => expect(v).toEqual({ title: "feat: x", bodyFile: "/b" }),
				onFailure: () => expect().fail("expected success"),
			});
		});
		test("fails when missing", () => {
			Result.match(validateGenerateContentOutput({}), {
				onSuccess: () => expect().fail("expected failure"),
				onFailure: () => {},
			});
		});
	});

	describe("buildGetCommitsGhEntries", () => {
		test("returns entries with count", () => {
			const entries = buildGetCommitsGhEntries("/c", "/f", 3);
			expect(entries).toEqual([
				{ key: "commits", value: "/c" },
				{ key: "files", value: "/f" },
				{ key: "count", value: "3" },
			]);
		});
	});

	describe("buildGenerateContentGhEntries", () => {
		test("returns entries with sanitized title", () => {
			Result.match(buildGenerateContentGhEntries("feat: add x", "/body.md"), {
				onSuccess: (entries) => {
					expect(entries[0]?.key).toBe("title");
					expect(entries[0]?.value).toBe("feat: add x");
					expect(entries[1]).toEqual({ key: "body_file", value: "/body.md" });
				},
				onFailure: () => expect().fail("expected success"),
			});
		});
	});

	describe("isHttpError", () => {
		test("true for 4xx and 5xx", () => {
			expect(isHttpError(400)).toBe(true);
			expect(isHttpError(404)).toBe(true);
			expect(isHttpError(500)).toBe(true);
		});
		test("false for 2xx and 3xx", () => {
			expect(isHttpError(200)).toBe(false);
			expect(isHttpError(302)).toBe(false);
		});
	});
});
