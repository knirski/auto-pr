import { describe, expect, test } from "bun:test";
import { Result } from "effect";
import { DescriptionParseError } from "#core/errors.js";
import type { CommitInfo } from "#core/fill-pr-template-core.js";
import {
	buildGeneratedDescriptionBlock,
	getFallbackTitleAndDescription,
	normalizeGeneratedBulletItems,
	normalizeGeneratedRiskItems,
	parseExistingPrTitleOutput,
	validateGeneratedContent,
} from "#core/generated-content.js";

function commit(overrides: Partial<CommitInfo>): CommitInfo {
	return {
		hash: "",
		subject: "feat: add generated content",
		body: "",
		fullMessage: "feat: add generated content",
		type: "feat",
		references: [],
		breakingNote: null,
		...overrides,
	};
}

describe("generated content core", () => {
	test("normalizes bullet and risk items", () => {
		expect(normalizeGeneratedBulletItems([" keep ", "", "  - not stripped "])).toEqual([
			"keep",
			"not stripped",
		]);
		expect(normalizeGeneratedRiskItems([" - review carefully ", "   "])).toEqual([
			"review carefully",
		]);
	});

	test("builds generated description sections", () => {
		expect(
			buildGeneratedDescriptionBlock({
				motivation: ["Explain the change"],
				benefits: ["Clearer PRs"],
				risks: ["Needs review"],
				notesForReviewers: "Focus on generated output.",
			}),
		).toBe(
			[
				"### Motivation\n- Explain the change",
				"### Benefits\n- Clearer PRs",
				"### Risks\n- Needs review",
				"### Notes for reviewers\nFocus on generated output.",
			].join("\n\n"),
		);
	});

	test("validates generated model content", () => {
		const result = validateGeneratedContent({
			title: "feat: improve generated descriptions",
			motivation: [" Useful context "],
			benefits: [],
			risks: [" - Review prompt changes "],
			notesForReviewers: "",
		});

		expect(Result.isSuccess(result)).toBe(true);
		if (Result.isSuccess(result)) {
			expect(result.success.title).toBe("feat: improve generated descriptions");
			expect(result.success.description).toContain("### Motivation\n- Useful context");
			expect(result.success.description).toContain("### Risks\n- Review prompt changes");
		}
	});

	test("rejects generated content without motivation", () => {
		const result = validateGeneratedContent({
			title: "feat: improve generated descriptions",
			motivation: ["   "],
			benefits: [],
			risks: ["Review prompt changes"],
			notesForReviewers: "",
		});

		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(result.failure).toBeInstanceOf(DescriptionParseError);
			expect(result.failure.cause).toBe("motivation is empty");
		}
	});

	test("builds fallback title and description from commits", () => {
		const result = getFallbackTitleAndDescription([
			commit({
				subject: "feat: add generated content",
				body: "Create a structured fallback body.",
			}),
			commit({
				subject: "fix: preserve provider compatibility",
				body: "",
				type: "fix",
			}),
		]);

		expect(result.title).toBe("feat: add generated content");
		expect(result.description).toContain("- Create a structured fallback body.");
		expect(result.description).toContain("- preserve provider compatibility");
		expect(result.description).toContain("AI description unavailable");
	});

	test("parses existing PR title output", () => {
		expect(parseExistingPrTitleOutput('{"title":" feat: current title "}')).toEqual({
			_tag: "Found",
			title: "feat: current title",
		});
		expect(parseExistingPrTitleOutput("")).toEqual({ _tag: "Missing" });
		expect(parseExistingPrTitleOutput('{"title":"   "}')).toEqual({ _tag: "Missing" });
		expect(parseExistingPrTitleOutput("not json")).toEqual({
			_tag: "Invalid",
			step: "parse",
			reason: "no JSON object in model output",
		});
		expect(parseExistingPrTitleOutput('{"name":"missing title"}')).toMatchObject({
			_tag: "Invalid",
			step: "schema",
		});
	});
});
