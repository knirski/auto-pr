/**
 * FillPrTemplate — Tagless Final interface for PR title and body generation.
 *
 * Single implementation (Live). Interface enables layer composition and clear R
 * declaration. Use FillPrTemplateTestMock (Layer.mock) for workflow tests.
 */

import type { Effect, FileSystem, Path } from "effect";
import { Schema } from "effect";
import type {
	FillPrTemplateValidationError,
	ParseError,
	PullRequestBodyBlankError,
	PullRequestTitleBlankError,
	TemplateRenderError,
} from "#auto-pr/errors.js";
import type { FileSystemError } from "#auto-pr/utils.js";

/** Schema for FillPrTemplateParams. Use for runtime validation at boundaries. */
export const FillPrTemplateParamsSchema = Schema.Struct({
	logFilePath: Schema.String,
	filesFilePath: Schema.String,
	templatePath: Schema.String,
	descriptionFilePath: Schema.optionalKey(Schema.String),
	/** Required for {{howToTest}} when not docs-only. Set via AUTO_PR_HOW_TO_TEST env. */
	howToTestDefault: Schema.String,
});

/** Parameters for loading commit log and files. */
export type FillPrTemplateParams = Schema.Schema.Type<typeof FillPrTemplateParamsSchema>;

export interface FillPrTemplateService {
	/** Returns PR title (first non-merge commit subject). Fails with PullRequestTitleBlankError if empty. */
	readonly getTitle: (
		params: FillPrTemplateParams,
	) => Effect.Effect<
		string,
		ParseError | FileSystemError | PullRequestTitleBlankError,
		FileSystem.FileSystem
	>;

	/** Returns filled PR template body. Fails with PullRequestBodyBlankError if empty. */
	readonly getBody: (
		params: FillPrTemplateParams,
	) => Effect.Effect<
		string,
		| FillPrTemplateValidationError
		| ParseError
		| FileSystemError
		| PullRequestBodyBlankError
		| TemplateRenderError,
		FileSystem.FileSystem | Path.Path
	>;
}
