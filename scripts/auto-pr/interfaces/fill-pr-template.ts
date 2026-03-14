/**
 * FillPrTemplate — Tagless Final interface for PR title and body generation.
 */

import type { Effect, FileSystem, Path } from "effect";
import type { ParseError, PrTitleBlank } from "../errors.js";
import type { FileSystemError } from "../utils.js";

/** Parameters for loading commit log and files. */
export interface FillPrTemplateParams {
	readonly logFilePath: string;
	readonly filesFilePath: string;
	readonly templatePath?: string | undefined;
	readonly descriptionFilePath?: string | undefined;
	/** Override for {{howToTest}} when not docs-only. Default: "1. Run `npm run check`\\n2. ". Set via AUTO_PR_HOW_TO_TEST env. */
	readonly howToTestDefault?: string | undefined;
}

export interface FillPrTemplateService {
	/** Returns PR title (first non-merge commit subject). Fails with PrTitleBlank if empty. */
	readonly getTitle: (
		params: FillPrTemplateParams,
	) => Effect.Effect<string, ParseError | FileSystemError | PrTitleBlank, FileSystem.FileSystem>;

	/** Returns filled PR template body. */
	readonly getBody: (
		params: FillPrTemplateParams,
	) => Effect.Effect<string, ParseError | FileSystemError, FileSystem.FileSystem | Path.Path>;
}
