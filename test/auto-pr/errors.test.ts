import { expect, test } from "bun:test";
import { Redacted } from "effect";
import {
	AiProviderError,
	AutoPrConfigError,
	BodyFileNotFoundError,
	DescriptionParseError,
	FillPrTemplateValidationError,
	formatError,
	NoSemanticCommitsError,
	ParseError,
	PullRequestBodyBlankError,
	PullRequestFailedError,
	PullRequestTitleBlankError,
	TemplateRenderError,
	UnexpectedError,
} from "#auto-pr/errors.js";
import { FileSystemError } from "#auto-pr/utils.js";

test("formatError formats PullRequestFailedError", () => {
	expect(formatError(new PullRequestFailedError({ cause: "git failed" }))).toBe("git failed");
});

test("formatError formats AiProviderError with status", () => {
	expect(formatError(new AiProviderError({ status: 500, cause: "server error" }))).toBe(
		"AI provider HTTP 500: server error",
	);
});

test("formatError formats AiProviderError without status", () => {
	expect(formatError(new AiProviderError({ cause: "timeout" }))).toBe("timeout");
});

test("formatError formats DescriptionParseError", () => {
	expect(formatError(new DescriptionParseError({ cause: "invalid schema" }))).toBe(
		"invalid schema",
	);
});

test("formatError formats AutoPrConfigError", () => {
	expect(formatError(new AutoPrConfigError({ missing: ["GH_TOKEN", "BRANCH"] }))).toContain(
		"Missing required env: GH_TOKEN, BRANCH",
	);
});

test("formatError formats PullRequestTitleBlankError", () => {
	expect(formatError(new PullRequestTitleBlankError({ message: "Empty title" }))).toContain(
		"conventionalcommits.org",
	);
});

test("formatError formats PullRequestBodyBlankError", () => {
	expect(formatError(new PullRequestBodyBlankError({ message: "Empty body" }))).toContain(
		"conventionalcommits.org",
	);
});

test("formatError formats ParseError", () => {
	expect(formatError(new ParseError({ message: "Bad commits" }))).toBe("Bad commits");
});

test("formatError formats ParseError with cause", () => {
	expect(formatError(new ParseError({ message: "Bad", cause: new Error("nested") }))).toContain(
		"Bad",
	);
	expect(formatError(new ParseError({ message: "Bad", cause: new Error("nested") }))).toContain(
		"nested",
	);
});

test("formatError formats NoSemanticCommitsError", () => {
	expect(formatError(new NoSemanticCommitsError({ message: "No commits" }))).toContain(
		"conventionalcommits.org",
	);
});

test("formatError formats BodyFileNotFoundError", () => {
	expect(formatError(new BodyFileNotFoundError({ path: "/tmp/body.md" }))).toContain(
		"PR body file does not exist",
	);
});

test("formatError formats TemplateRenderError", () => {
	expect(formatError(new TemplateRenderError({ message: "Template failed" }))).toBe(
		"Template failed",
	);
});

test("formatError formats TemplateRenderError with cause", () => {
	const out = formatError(new TemplateRenderError({ message: "Render error", cause: "syntax" }));
	expect(out).toContain("Render error");
	expect(out).toContain("syntax");
});

test("formatError formats FillPrTemplateValidationError", () => {
	expect(formatError(new FillPrTemplateValidationError({ message: "templatePath required" }))).toBe(
		"templatePath required",
	);
});

test("formatError formats UnexpectedError", () => {
	expect(formatError(new UnexpectedError({ cause: "commits: ENOENT" }))).toBe("commits: ENOENT");
});

test("formatError formats FileSystemError (fallback path)", () => {
	const err = new FileSystemError({
		path: Redacted.make("/tmp/foo.txt", { label: "foo.txt" }),
		operation: "readFileString",
		message: "ENOENT",
	});
	expect(formatError(err)).toContain("File system error");
	expect(formatError(err)).toContain("readFileString");
	expect(formatError(err)).toContain("foo.txt");
	expect(formatError(err)).toContain("ENOENT");
});

test("formatError formats plain Error", () => {
	expect(formatError(new Error("generic"))).toBe("generic");
});
