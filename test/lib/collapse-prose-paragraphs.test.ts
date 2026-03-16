import { describe, expect, test } from "vitest";
import { collapseProseParagraphs } from "#lib/collapse-prose-paragraphs.js";

describe("collapse-prose-paragraphs", () => {
	describe("collapseProseParagraphs", () => {
		test("returns blank input unchanged", () => {
			expect(collapseProseParagraphs("")).toBe("");
			expect(collapseProseParagraphs("   ")).toBe("   ");
			expect(collapseProseParagraphs("\t\n")).toBe("\t\n");
		});

		test("collapses newlines within prose paragraph to space", () => {
			const input = "First line.\nSecond line.\nThird line.";
			expect(collapseProseParagraphs(input)).toBe("First line. Second line. Third line.");
		});

		test("preserves paragraph breaks (blank lines between paragraphs)", () => {
			const input = "First paragraph line one.\nFirst paragraph line two.\n\nSecond paragraph.";
			expect(collapseProseParagraphs(input)).toBe(
				"First paragraph line one. First paragraph line two.\n\nSecond paragraph.",
			);
		});

		test("preserves bullet lists (remark AST)", () => {
			const input =
				"- Count only semantic commits\n- Move CI scripts to .github/scripts/\n- Sanitize GITHUB_OUTPUT";
			const result = collapseProseParagraphs(input);
			expect(result).toContain("Count only semantic commits");
			expect(result).toContain("Move CI scripts to .github/scripts/");
			expect(result).toContain("Sanitize GITHUB");
		});

		test("preserves code blocks (remark AST)", () => {
			const input = "Use:\n\n```\nPR_NUMBER=123 python script.py\n```";
			const result = collapseProseParagraphs(input);
			expect(result).toContain("Use:");
			expect(result).toContain("```");
			expect(result).toContain("PR_NUMBER=123 python script.py");
		});

		test("collapses prose but preserves mixed content", () => {
			const input =
				"Release Please force-pushes frequently, which was cancelling CI runs\nbefore they completed.\n\n- Set cancel-in-progress to false";
			const result = collapseProseParagraphs(input);
			expect(result).toContain("Release Please force-pushes frequently");
			expect(result).toContain("before they completed");
			expect(result).toContain("Set cancel-in-progress to false");
		});

		test("single paragraph with multiple newlines", () => {
			const input = "a\n\nb\n\nc";
			const result = collapseProseParagraphs(input);
			// Three paragraphs: "a", "b", "c" - each single line, no internal collapse
			expect(result).toContain("a");
			expect(result).toContain("b");
			expect(result).toContain("c");
		});
	});
});
