/**
 * Tagged domain errors for auto-PR. Pure class definitions.
 * formatError (shell) lives in auto-pr/errors.ts.
 */

import { Schema } from "effect";

// ─── Github / PullRequest ────────────────────────────────────────────────────

/** GitHub PR operation failed (auth, network, rate limit, etc.). */
export class PullRequestFailedError extends Schema.TaggedError<PullRequestFailedError>()(
  "PullRequestFailedError",
  { cause: Schema.String },
) {}

/** PR lookup failed or returned invalid data. Distinct from "no PR yet" (Option.none). */
export class PullRequestLookupError extends Schema.TaggedError<PullRequestLookupError>()(
  "PullRequestLookupError",
  {
    branch: Schema.String,
    cause: Schema.String,
  },
) {}

/** `gh pr create` output could not be parsed into a PR URL. */
export class PullRequestUrlParseError extends Schema.TaggedError<PullRequestUrlParseError>()(
  "PullRequestUrlParseError",
  {
    raw: Schema.String,
    reason: Schema.String,
  },
) {}

/** Missing required env vars. Config validation failed. */
export class AutoPrConfigError extends Schema.TaggedError<AutoPrConfigError>()(
  "AutoPrConfigError",
  { missing: Schema.Array(Schema.String) },
) {}

/** Routing output contract is invalid or missing required values. */
export class ModelRoutingOutputError extends Schema.TaggedError<ModelRoutingOutputError>()(
  "ModelRoutingOutputError",
  { message: Schema.String },
) {}

/** Pull request title is empty. Add at least one non-merge commit with non-empty subject. */
export class PullRequestTitleBlankError extends Schema.TaggedError<PullRequestTitleBlankError>()(
  "PullRequestTitleBlankError",
  { message: Schema.String },
) {}

/** Pull request body is empty. Add at least one non-merge commit with non-empty body. */
export class PullRequestBodyBlankError extends Schema.TaggedError<PullRequestBodyBlankError>()(
  "PullRequestBodyBlankError",
  { message: Schema.String },
) {}

/** `pr-body.md` path does not exist. Check generate-content step succeeded. */
export class BodyFileNotFoundError extends Schema.TaggedError<BodyFileNotFoundError>()(
  "BodyFileNotFoundError",
  { path: Schema.String },
) {}

// ─── AI provider (local LLM, GitHub Models) ──────────────────────────────────

/** Transport/API failures from any AI provider. */
export class AiProviderError extends Schema.TaggedError<AiProviderError>()("AiProviderError", {
  status: Schema.optional(Schema.Number),
  cause: Schema.String,
}) {}

/** Schema decode or validateTitleDescription failures. */
export class DescriptionParseError extends Schema.TaggedError<DescriptionParseError>()(
  "DescriptionParseError",
  { cause: Schema.String },
) {}

// ─── Commit / template parsing ────────────────────────────────────────────────

/** Parse error for commit message parsing failures. Used by fill-pr-template. */
export class ParseError extends Schema.TaggedError<ParseError>()("ParseError", {
  message: Schema.String,
  cause: Schema.optional(Schema.String),
}) {}

/** No semantic commits (all merge or non-semantic). Add at least one non-merge commit. */
export class NoSemanticCommitsError extends Schema.TaggedError<NoSemanticCommitsError>()(
  "NoSemanticCommitsError",
  { message: Schema.String },
) {}

// ─── template ─────────────────────────────────────────────────────────────────

/** Template render failed (micromustache syntax error). */
export class TemplateRenderError extends Schema.TaggedError<TemplateRenderError>()(
  "TemplateRenderError",
  { message: Schema.String, cause: Schema.optional(Schema.String) },
) {}

/** FillPrTemplate params validation failed (e.g. templatePath required). */
export class FillPrTemplateValidationError extends Schema.TaggedError<FillPrTemplateValidationError>()(
  "FillPrTemplateValidationError",
  { message: Schema.String },
) {}

/** Local act runner (`act-local-ci`) failed. */
export class ActLocalCiError extends Schema.TaggedError<ActLocalCiError>()("ActLocalCiError", {
  reason: Schema.String,
}) {}

/** Unexpected error during generate-content; wraps unknown failures (e.g. non-Error throws). */
export class UnexpectedError extends Schema.TaggedError<UnexpectedError>()("UnexpectedError", {
  cause: Schema.String,
}) {}
