/**
 * Pure core for auto-PR. No Effect, no I/O. Returns Result where needed.
 * Shell (auto-pr) and workflow/tools depend on core.
 */

export {
	collapseProseParagraphs,
	fallbackWhenParseFails,
} from "#core/collapse-prose-paragraphs.js";
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
	PullRequestLookupError,
	PullRequestTitleBlankError,
	PullRequestUrlParseError,
	TemplateRenderError,
	UnexpectedError,
} from "#core/errors.js";
export type { CommitInfo, TemplateData, TypeOfChange } from "#core/fill-pr-template-core.js";
export {
	BREAKING_CHANGES_BODY_MAX_LENGTH,
	extractBreakingDescriptionFromLine,
	fillTemplate,
	filterMergeCommits,
	fitConventionalTitleToLengthLimit,
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
	isBreakingConventionalTitle,
	isConventional,
	isDocsOnly,
	isMergeCommit,
	isValidConventionalTitle,
	isWithinLengthLimit,
	matchesConventionalTitleFormat,
	parseCommits,
	parseFilesContent,
	renderBody,
	resolveBreakingChangesBody,
	validateTitleDescription,
} from "#core/fill-pr-template-core.js";
export type {
	ExistingPrTitleParseResult,
	GeneratedTitleDescription,
} from "#core/generated-content.js";
export {
	buildGeneratedDescriptionBlock,
	getFallbackTitleAndDescription,
	normalizeGeneratedBulletItems,
	normalizeGeneratedRiskItems,
	parseExistingPrTitleOutput,
	validateGeneratedContent,
} from "#core/generated-content.js";
export type { GhOutputValue } from "#core/gh-output.js";
export {
	buildGetCommitsGhEntries,
	decodeGhOutputTitle,
	formatGhOutput,
	getGhOutputValue,
	parseGhOutput,
	sanitizeForGhOutput,
	validateGetCommitsOutput,
} from "#core/gh-output.js";
export * from "#core/github-model-routing.js";
export type { InitFileSpec } from "#core/init-core.js";
export { getInitFileSpecs } from "#core/init-core.js";
export * from "#core/model-routing.js";
export type { ParsedJson, ParsedJsonObject } from "#core/parse-model-json.js";
export { parseFirstJsonObject } from "#core/parse-model-json.js";
export { PR_TITLE_LINE_MAX_LENGTH } from "#core/pr-title-line-max-length.js";
export { buildDescriptionPrompt } from "#core/prompt.js";
export {
	filterSemanticSubjects,
	isBlank,
	isHttpError,
	isMergeCommitSubject,
	nonBlankOption,
	parseSubjects,
	toError,
	unknownToMessage,
} from "#core/string.js";
export type { TitleDescription } from "#core/title-description.js";
export {
	parseTitleDescriptionFromAssistantText,
	TitleDescriptionSchema,
} from "#core/title-description.js";
