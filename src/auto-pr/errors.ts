/**
 * Error formatting for shell. Tagged error classes live in #core/errors.
 */

import { Match } from "effect";
import { CliError } from "effect/unstable/cli";
import {
	errorToLogMessage,
	FileSystemError,
	formatFileSystemError,
	unknownToMessage,
} from "#auto-pr/utils.js";
import {
	ActLocalCiError,
	AiProviderError,
	AutoPrConfigError,
	BodyFileNotFoundError,
	DescriptionParseError,
	FillPrTemplateValidationError,
	NoSemanticCommitsError,
	ParseError,
	PullRequestBodyBlankError,
	PullRequestFailedError,
	PullRequestTitleBlankError,
	TemplateRenderError,
	UnexpectedError,
} from "#core/errors.js";

export {
	ActLocalCiError,
	AiProviderError,
	AutoPrConfigError,
	BodyFileNotFoundError,
	DescriptionParseError,
	FillPrTemplateValidationError,
	NoSemanticCommitsError,
	ParseError,
	PullRequestBodyBlankError,
	PullRequestFailedError,
	PullRequestTitleBlankError,
	TemplateRenderError,
	UnexpectedError,
} from "#core/errors.js";

/** Format script errors for logs. */
export function formatError(e: unknown): string {
	if (CliError.isCliError(e)) {
		return e.message;
	}
	if (
		e instanceof ActLocalCiError ||
		e instanceof PullRequestFailedError ||
		e instanceof AiProviderError ||
		e instanceof AutoPrConfigError ||
		e instanceof PullRequestTitleBlankError ||
		e instanceof PullRequestBodyBlankError ||
		e instanceof BodyFileNotFoundError ||
		e instanceof DescriptionParseError ||
		e instanceof ParseError ||
		e instanceof NoSemanticCommitsError ||
		e instanceof TemplateRenderError ||
		e instanceof FillPrTemplateValidationError ||
		e instanceof UnexpectedError
	) {
		return Match.value(e).pipe(
			Match.tag("ActLocalCiError", ({ reason }) => reason),
			Match.tag("PullRequestFailedError", ({ cause }) => cause),
			Match.tag("AiProviderError", ({ status, cause }) =>
				status == null ? cause : `AI provider HTTP ${status}: ${cause}`,
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
					`PR body file does not exist: ${path}. Check generate-content step succeeded. See https://github.com/knirski/auto-pr/blob/main/docs/INTEGRATION.md#troubleshooting`,
			),
			Match.tag("DescriptionParseError", ({ cause }) => cause),
			Match.tag("ParseError", ({ message, cause }) =>
				cause == null ? message : `${message}: ${String(cause)}`,
			),
			Match.tag(
				"NoSemanticCommitsError",
				({ message }) => `${message} See https://www.conventionalcommits.org`,
			),
			Match.tag("TemplateRenderError", ({ message, cause }) =>
				cause == null ? message : `${message}: ${String(cause)}`,
			),
			Match.tag("FillPrTemplateValidationError", ({ message }) => message),
			Match.tag("UnexpectedError", ({ cause }) => cause),
			Match.exhaustive,
		);
	}
	return errorToLogMessage(e, (err) => {
		if (err instanceof FileSystemError) return formatFileSystemError(err);
		return unknownToMessage(e);
	});
}
