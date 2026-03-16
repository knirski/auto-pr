/**
 * Tagged domain errors for auto-PR scripts.
 * Self-contained for standalone package.
 */

import { Match, Schema } from "effect";
import {
	errorToLogMessage,
	FileSystemError,
	formatFileSystemError,
	unknownToMessage,
} from "#auto-pr/utils.js";

// ─── Github / PullRequest ────────────────────────────────────────────────────

/** gh CLI failed when creating or editing a PR (auth, network, rate limit, etc.). */
export class PullRequestFailedError extends Schema.TaggedErrorClass<PullRequestFailedError>()(
	"PullRequestFailedError",
	{ cause: Schema.String },
) {}

/** Missing required env vars. Config validation failed. */
export class AutoPrConfigError extends Schema.TaggedErrorClass<AutoPrConfigError>()(
	"AutoPrConfigError",
	{ missing: Schema.Array(Schema.String) },
) {}

/** Pull request title is empty. Add at least one non-merge commit with non-empty subject. */
export class PullRequestTitleBlankError extends Schema.TaggedErrorClass<PullRequestTitleBlankError>()(
	"PullRequestTitleBlankError",
	{ message: Schema.String },
) {}

/** Pull request body is empty. Add at least one non-merge commit with non-empty body. */
export class PullRequestBodyBlankError extends Schema.TaggedErrorClass<PullRequestBodyBlankError>()(
	"PullRequestBodyBlankError",
	{ message: Schema.String },
) {}

/** BODY_FILE path does not exist. Check generate-content step succeeded. */
export class BodyFileNotFoundError extends Schema.TaggedErrorClass<BodyFileNotFoundError>()(
	"BodyFileNotFoundError",
	{ path: Schema.String },
) {}

// ─── Ollama ──────────────────────────────────────────────────────────────────

/** Ollama HTTP request failed (timeout, 5xx, etc.). */
export class OllamaHttpError extends Schema.TaggedErrorClass<OllamaHttpError>()("OllamaHttpError", {
	status: Schema.optional(Schema.Number),
	cause: Schema.String,
}) {}

/** Ollama description response empty or invalid. */
export class OllamaDescriptionInvalidError extends Schema.TaggedErrorClass<OllamaDescriptionInvalidError>()(
	"OllamaDescriptionInvalidError",
	{ cause: Schema.String },
) {}

// ─── Commit / template parsing ────────────────────────────────────────────────

/** Parse error for commit message parsing failures. Used by fill-pr-template. */
export class ParseError extends Schema.TaggedErrorClass<ParseError>()("ParseError", {
	message: Schema.String,
	cause: Schema.optional(Schema.Unknown),
}) {}

/** No semantic commits (all merge or non-semantic). Add at least one non-merge commit. */
export class NoSemanticCommitsError extends Schema.TaggedErrorClass<NoSemanticCommitsError>()(
	"NoSemanticCommitsError",
	{ message: Schema.String },
) {}

// ─── update-nix-hash / update-npm-deps-hash ───────────────────────────────────

/** update-nix-hash: invalid hash or missing argument. */
export class UpdateNixHashUsageError extends Schema.TaggedErrorClass<UpdateNixHashUsageError>()(
	"UpdateNixHashUsageError",
	{ message: Schema.String },
) {}

/** update-nix-hash: no npmDepsHash found in default.nix. */
export class UpdateNixHashNotFoundError extends Schema.TaggedErrorClass<UpdateNixHashNotFoundError>()(
	"UpdateNixHashNotFoundError",
	{ path: Schema.String },
) {}

// ─── template ───────────────────────────────────────────────────────────────

/** Template render failed (micromustache syntax error). */
export class TemplateRenderError extends Schema.TaggedErrorClass<TemplateRenderError>()(
	"TemplateRenderError",
	{ message: Schema.String, cause: Schema.optional(Schema.Unknown) },
) {}

/** FillPrTemplate params validation failed (e.g. templatePath required). */
export class FillPrTemplateValidationError extends Schema.TaggedErrorClass<FillPrTemplateValidationError>()(
	"FillPrTemplateValidationError",
	{ message: Schema.String },
) {}

/** Format script errors for logs. */
export function formatError(e: unknown): string {
	if (
		e instanceof PullRequestFailedError ||
		e instanceof OllamaHttpError ||
		e instanceof AutoPrConfigError ||
		e instanceof PullRequestTitleBlankError ||
		e instanceof PullRequestBodyBlankError ||
		e instanceof BodyFileNotFoundError ||
		e instanceof OllamaDescriptionInvalidError ||
		e instanceof ParseError ||
		e instanceof NoSemanticCommitsError ||
		e instanceof UpdateNixHashUsageError ||
		e instanceof UpdateNixHashNotFoundError ||
		e instanceof TemplateRenderError ||
		e instanceof FillPrTemplateValidationError
	) {
		return Match.value(e).pipe(
			Match.tag("PullRequestFailedError", ({ cause }) => cause),
			Match.tag("OllamaHttpError", ({ status, cause }) =>
				status == null ? cause : `Ollama HTTP ${status}: ${cause}`,
			),
			Match.tag(
				"AutoPrConfigError",
				({ missing }) =>
					`Missing required env: ${missing.join(", ")}. See https://github.com/knirski/auto-pr#environment-variables`,
			),
			Match.tag(
				"PullRequestTitleBlankError",
				({ message }) => `${message} See https://www.conventionalcommits.org`,
			),
			Match.tag(
				"PullRequestBodyBlankError",
				({ message }) => `${message} See https://www.conventionalcommits.org`,
			),
			Match.tag(
				"BodyFileNotFoundError",
				({ path }) =>
					`BODY_FILE does not exist: ${path}. Check generate-content step succeeded. See https://github.com/knirski/auto-pr/blob/main/docs/INTEGRATION.md#troubleshooting`,
			),
			Match.tag("OllamaDescriptionInvalidError", ({ cause }) => cause),
			Match.tag("ParseError", ({ message, cause }) =>
				cause == null ? message : `${message}: ${String(cause)}`,
			),
			Match.tag(
				"NoSemanticCommitsError",
				({ message }) => `${message} See https://www.conventionalcommits.org`,
			),
			Match.tag("UpdateNixHashUsageError", ({ message }) => message),
			Match.tag("UpdateNixHashNotFoundError", ({ path }) => `No npmDepsHash found in ${path}`),
			Match.tag("TemplateRenderError", ({ message, cause }) =>
				cause == null ? message : `${message}: ${String(cause)}`,
			),
			Match.tag("FillPrTemplateValidationError", ({ message }) => message),
			Match.exhaustive,
		);
	}
	return errorToLogMessage(e, (err) => {
		if (err instanceof FileSystemError) return formatFileSystemError(err);
		return unknownToMessage(e);
	});
}
