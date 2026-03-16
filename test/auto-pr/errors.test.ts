import { Redacted } from "effect";
import { expect, it } from "vitest";
import {
	AutoPrConfigError,
	BodyFileNotFoundError,
	FillPrTemplateValidationError,
	formatError,
	NoSemanticCommitsError,
	OllamaDescriptionInvalidError,
	OllamaHttpError,
	ParseError,
	PullRequestBodyBlankError,
	PullRequestFailedError,
	PullRequestTitleBlankError,
	TemplateRenderError,
	UpdateNixHashNotFoundError,
	UpdateNixHashUsageError,
} from "#auto-pr/errors.js";
import { FileSystemError } from "#auto-pr/utils.js";

it("formatError formats PullRequestFailedError", () => {
	expect(formatError(new PullRequestFailedError({ cause: "git failed" }))).toBe("git failed");
});

it("formatError formats OllamaHttpError with status", () => {
	expect(formatError(new OllamaHttpError({ status: 500, cause: "server error" }))).toBe(
		"Ollama HTTP 500: server error",
	);
});

it("formatError formats OllamaHttpError without status", () => {
	expect(formatError(new OllamaHttpError({ cause: "timeout" }))).toBe("timeout");
});

it("formatError formats AutoPrConfigError", () => {
	expect(formatError(new AutoPrConfigError({ missing: ["GH_TOKEN", "BRANCH"] }))).toContain(
		"Missing required env: GH_TOKEN, BRANCH",
	);
});

it("formatError formats PullRequestTitleBlankError", () => {
	expect(formatError(new PullRequestTitleBlankError({ message: "Empty title" }))).toContain(
		"conventionalcommits.org",
	);
});

it("formatError formats PullRequestBodyBlankError", () => {
	expect(formatError(new PullRequestBodyBlankError({ message: "Empty body" }))).toContain(
		"conventionalcommits.org",
	);
});

it("formatError formats ParseError", () => {
	expect(formatError(new ParseError({ message: "Bad commits" }))).toBe("Bad commits");
});

it("formatError formats ParseError with cause", () => {
	expect(formatError(new ParseError({ message: "Bad", cause: new Error("nested") }))).toContain(
		"Bad",
	);
	expect(formatError(new ParseError({ message: "Bad", cause: new Error("nested") }))).toContain(
		"nested",
	);
});

it("formatError formats NoSemanticCommitsError", () => {
	expect(formatError(new NoSemanticCommitsError({ message: "No commits" }))).toContain(
		"conventionalcommits.org",
	);
});

it("formatError formats BodyFileNotFoundError", () => {
	expect(formatError(new BodyFileNotFoundError({ path: "/tmp/body.md" }))).toContain(
		"BODY_FILE does not exist",
	);
});

it("formatError formats OllamaDescriptionInvalidError", () => {
	expect(formatError(new OllamaDescriptionInvalidError({ cause: "empty" }))).toBe("empty");
});

it("formatError formats UpdateNixHashUsageError", () => {
	expect(formatError(new UpdateNixHashUsageError({ message: "Usage: ..." }))).toBe("Usage: ...");
});

it("formatError formats UpdateNixHashNotFoundError", () => {
	expect(formatError(new UpdateNixHashNotFoundError({ path: "/default.nix" }))).toBe(
		"No npmDepsHash found in /default.nix",
	);
});

it("formatError formats TemplateRenderError", () => {
	expect(formatError(new TemplateRenderError({ message: "Template failed" }))).toBe(
		"Template failed",
	);
});

it("formatError formats TemplateRenderError with cause", () => {
	const out = formatError(new TemplateRenderError({ message: "Render error", cause: "syntax" }));
	expect(out).toContain("Render error");
	expect(out).toContain("syntax");
});

it("formatError formats FillPrTemplateValidationError", () => {
	expect(formatError(new FillPrTemplateValidationError({ message: "templatePath required" }))).toBe(
		"templatePath required",
	);
});

it("formatError formats FileSystemError (fallback path)", () => {
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

it("formatError formats plain Error", () => {
	expect(formatError(new Error("generic"))).toBe("generic");
});
