/**
 * Tagged domain errors for auto-PR. Pure class definitions.
 * formatError (shell) lives in auto-pr/errors.ts.
 */

import { Schema } from "effect";

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

/** `pr-body.md` path does not exist. Check generate-content step succeeded. */
export class BodyFileNotFoundError extends Schema.TaggedErrorClass<BodyFileNotFoundError>()(
	"BodyFileNotFoundError",
	{ path: Schema.String },
) {}

// ─── AI provider (local LLM, GitHub Models) ──────────────────────────────────

/** Transport/API failures from any AI provider. */
export class AiProviderError extends Schema.TaggedErrorClass<AiProviderError>()("AiProviderError", {
	status: Schema.optional(Schema.Number),
	cause: Schema.String,
}) {}

/** Schema decode or validateTitleDescription failures. */
export class DescriptionParseError extends Schema.TaggedErrorClass<DescriptionParseError>()(
	"DescriptionParseError",
	{ cause: Schema.String },
) {}

// ─── Commit / template parsing ────────────────────────────────────────────────

/** Parse error for commit message parsing failures. Used by fill-pr-template. */
export class ParseError extends Schema.TaggedErrorClass<ParseError>()("ParseError", {
	message: Schema.String,
	cause: Schema.optional(Schema.String),
}) {}

/** No semantic commits (all merge or non-semantic). Add at least one non-merge commit. */
export class NoSemanticCommitsError extends Schema.TaggedErrorClass<NoSemanticCommitsError>()(
	"NoSemanticCommitsError",
	{ message: Schema.String },
) {}

// ─── template ─────────────────────────────────────────────────────────────────

/** Template render failed (micromustache syntax error). */
export class TemplateRenderError extends Schema.TaggedErrorClass<TemplateRenderError>()(
	"TemplateRenderError",
	{ message: Schema.String, cause: Schema.optional(Schema.String) },
) {}

/** FillPrTemplate params validation failed (e.g. templatePath required). */
export class FillPrTemplateValidationError extends Schema.TaggedErrorClass<FillPrTemplateValidationError>()(
	"FillPrTemplateValidationError",
	{ message: Schema.String },
) {}

/** Local act runner (`act-local-ci`) failed. */
export class ActLocalCiError extends Schema.TaggedErrorClass<ActLocalCiError>()("ActLocalCiError", {
	reason: Schema.String,
}) {}

/** Unexpected error during generate-content; wraps unknown failures (e.g. non-Error throws). */
export class UnexpectedError extends Schema.TaggedErrorClass<UnexpectedError>()("UnexpectedError", {
	cause: Schema.String,
}) {}
