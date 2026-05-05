import { describe, expect, test } from "bun:test";
import { Result } from "effect";
import { DescriptionParseError } from "#core/errors.js";
import { parseTitleDescriptionFromAssistantText } from "#core/title-description.js";

describe("parseTitleDescriptionFromAssistantText", () => {
  test("decodes a plain JSON object", () => {
    const result = parseTitleDescriptionFromAssistantText(
      JSON.stringify({
        title: "feat: add generated summaries",
        motivation: ["Explain why the change exists"],
        benefits: ["Clearer PR context"],
        risks: ["Generated wording may need review"],
        notesForReviewers: "Check the generated title.",
      }),
    );

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success.title).toBe("feat: add generated summaries");
      expect(result.success.motivation).toEqual(["Explain why the change exists"]);
    }
  });

  test("decodes the first JSON object embedded in assistant prose", () => {
    const result = parseTitleDescriptionFromAssistantText(`
Here is the PR content:
{
  "title": "fix: keep generated output compatible",
  "motivation": ["Avoid provider-specific structured output"],
  "benefits": ["Works with GitHub Models"],
  "risks": ["None"],
  "notesForReviewers": ""
}
`);

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success.title).toBe("fix: keep generated output compatible");
      expect(result.success.risks).toEqual(["None"]);
    }
  });

  test("returns DescriptionParseError when no JSON object is present", () => {
    const result = parseTitleDescriptionFromAssistantText("no structured content");

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(DescriptionParseError);
      expect(result.failure.cause).toBe("no JSON object in model output");
    }
  });

  test("returns DescriptionParseError when the object has the wrong shape", () => {
    const result = parseTitleDescriptionFromAssistantText(
      JSON.stringify({
        title: "feat: missing sections",
        motivation: "not an array",
        benefits: [],
        risks: [],
        notesForReviewers: "",
      }),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(DescriptionParseError);
      expect(result.failure.cause).toContain("Expected array");
      expect(result.failure.cause).toContain('["motivation"]');
    }
  });
});
