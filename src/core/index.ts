/**
 * Pure core for auto-PR. No Effect, no I/O. Returns Result where needed.
 * Shell (auto-pr) and workflow/tools depend on core.
 */

export {
	collapseProseParagraphs,
	fallbackWhenParseFails,
} from "#core/collapse-prose-paragraphs.js";
export {
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
export type { CommitInfo, TemplateData, TypeOfChange } from "#core/fill-pr-template-core.js";
export {
	fillTemplate,
	filterMergeCommits,
	formatTitleBody,
	getBreakingChanges,
	getChanges,
	getDescription,
	getDescriptionFromCommits,
	getDescriptionPromptText,
	getRelatedIssues,
	getTitle,
	hasDocsFiles,
	hasTestFiles,
	hasUnreplacedPlaceholders,
	isConventional,
	isDocsOnly,
	isMergeCommit,
	isValidConventionalTitle,
	parseCommits,
	parseFilesContent,
	renderBody,
	validateTitleDescription,
} from "#core/fill-pr-template-core.js";
export type { GhOutputValue } from "#core/gh-output.js";
export {
	buildGenerateContentGhEntries,
	buildGetCommitsGhEntries,
	decodeGhOutputTitle,
	formatGhOutput,
	getGhOutputValue,
	parseGhOutput,
	sanitizeForGhOutput,
	validateGenerateContentOutput,
	validateGetCommitsOutput,
} from "#core/gh-output.js";
export type { InitFileSpec } from "#core/init-core.js";
export { getInitFileSpecs } from "#core/init-core.js";
export { buildDescriptionPrompt } from "#core/prompt.js";
export {
	filterSemanticSubjects,
	isBlank,
	isHttpError,
	isMergeCommitSubject,
	parseSubjects,
	toError,
	unknownToMessage,
} from "#core/string.js";
