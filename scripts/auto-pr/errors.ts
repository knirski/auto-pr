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
} from "./utils.js";

export class GhPrFailed extends Schema.TaggedErrorClass<GhPrFailed>()("GhPrFailed", {
	cause: Schema.String,
}) {}

export class OllamaHttpError extends Schema.TaggedErrorClass<OllamaHttpError>()("OllamaHttpError", {
	status: Schema.optional(Schema.Number),
	cause: Schema.String,
}) {}

export class AutoPrConfigError extends Schema.TaggedErrorClass<AutoPrConfigError>()(
	"AutoPrConfigError",
	{ missing: Schema.Array(Schema.String) },
) {}

export class PrTitleBlank extends Schema.TaggedErrorClass<PrTitleBlank>()("PrTitleBlank", {
	message: Schema.String,
}) {}

/** Parse error for commit message parsing failures. Used by fill-pr-template. */
export class ParseError extends Schema.TaggedErrorClass<ParseError>()("ParseError", {
	message: Schema.String,
	cause: Schema.optional(Schema.Unknown),
}) {}

/** No semantic commits (all merge or non-semantic). Add at least one non-merge commit. */
export class NoSemanticCommits extends Schema.TaggedErrorClass<NoSemanticCommits>()(
	"NoSemanticCommits",
	{ message: Schema.String },
) {}

/** BODY_FILE path does not exist. */
export class BodyFileNotFound extends Schema.TaggedErrorClass<BodyFileNotFound>()(
	"BodyFileNotFound",
	{
		path: Schema.String,
	},
) {}

/** Ollama description response empty or invalid. */
export class OllamaDescriptionInvalid extends Schema.TaggedErrorClass<OllamaDescriptionInvalid>()(
	"OllamaDescriptionInvalid",
	{ cause: Schema.String },
) {}

/** Format script errors for logs. */
export function formatAutoPrError(e: unknown): string {
	if (
		e instanceof GhPrFailed ||
		e instanceof OllamaHttpError ||
		e instanceof AutoPrConfigError ||
		e instanceof PrTitleBlank ||
		e instanceof ParseError ||
		e instanceof NoSemanticCommits ||
		e instanceof BodyFileNotFound ||
		e instanceof OllamaDescriptionInvalid
	) {
		return Match.value(e).pipe(
			Match.tag("GhPrFailed", ({ cause }) => cause),
			Match.tag("OllamaHttpError", ({ status, cause }) =>
				status != null ? `Ollama HTTP ${status}: ${cause}` : cause,
			),
			Match.tag(
				"AutoPrConfigError",
				({ missing }) =>
					`Missing required env: ${missing.join(", ")}. See https://github.com/knirski/auto-pr#environment-variables`,
			),
			Match.tag(
				"PrTitleBlank",
				({ message }) => `${message} See https://www.conventionalcommits.org`,
			),
			Match.tag("ParseError", ({ message, cause }) =>
				cause != null ? `${message}: ${String(cause)}` : message,
			),
			Match.tag(
				"NoSemanticCommits",
				({ message }) => `${message} See https://www.conventionalcommits.org`,
			),
			Match.tag(
				"BodyFileNotFound",
				({ path }) =>
					`BODY_FILE does not exist: ${path}. Check generate-content step succeeded. See https://github.com/knirski/auto-pr/blob/main/docs/INTEGRATION.md#troubleshooting`,
			),
			Match.tag("OllamaDescriptionInvalid", ({ cause }) => cause),
			Match.exhaustive,
		);
	}
	return errorToLogMessage(e, (err) => {
		if (err instanceof FileSystemError) return formatFileSystemError(err);
		return unknownToMessage(e);
	});
}
