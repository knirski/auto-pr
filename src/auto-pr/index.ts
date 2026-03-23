/**
 * Auto-PR shared module. Core (pure) + shell (Effect).
 *
 * Path aliases: #auto-pr (this), #core, #workflow/*, #tools/*
 */

export type { AiProvider } from "#auto-pr/config.js";
export {
	CreateOrUpdatePrConfig,
	CreateOrUpdatePrConfigLayer,
	GeneratePrContentConfig,
	GeneratePrContentConfigLayer,
	GetCommitsConfig,
	GetCommitsConfigLayer,
	RunAutoPrConfig,
	RunAutoPrConfigLayer,
} from "#auto-pr/config.js";
export type { GhOutputValue } from "#auto-pr/core.js";
export {
	buildDescriptionPrompt,
	buildGetCommitsGhEntries,
	decodeGhOutputTitle,
	filterSemanticSubjects,
	formatGhOutput,
	getGhOutputValue,
	isBlank,
	isHttpError,
	isMergeCommitSubject,
	parseGhOutput,
	parseSubjects,
	sanitizeForGhOutput,
	validateGetCommitsOutput,
} from "#auto-pr/core.js";
export {
	AiProviderError,
	AutoPrConfigError,
	BodyFileNotFoundError,
	DescriptionParseError,
	FillPrTemplateValidationError,
	formatError,
	NoSemanticCommitsError,
	ParseError,
	PullRequestBodyBlankError,
	PullRequestFailedError,
	PullRequestTitleBlankError,
	TemplateRenderError,
	UnexpectedError,
} from "#auto-pr/errors.js";

export type { FillPrTemplateParams } from "#auto-pr/interfaces/fill-pr-template.js";
export { FillPrTemplateParamsSchema } from "#auto-pr/interfaces/fill-pr-template.js";
export {
	type AiProviderConfig,
	aiProviderLayerFromConfig,
} from "#auto-pr/live/ai-provider.js";
export { FillPrTemplate, renderBody } from "#auto-pr/live/fill-pr-template.js";
export { ollamaLanguageModelLayer } from "#auto-pr/live/ollama-language-model.js";
export {
	getPrDescriptionPromptPath,
	PR_BODY_FILE_NAME,
	PR_TITLE_FILE_NAME,
} from "#auto-pr/paths.js";
export {
	AutoPrLoggerLayer,
	appendGhOutput,
	ChildProcessSpawnerLayer,
	getDebugHint,
	PlatformLayer as AutoPrPlatformLayer,
	runCommand,
	runMain,
} from "#auto-pr/shell.js";
export {
	type FileSystemError,
	mapFsError,
	redactPath,
	toError,
	unknownToMessage,
} from "#auto-pr/utils.js";
export { validateTitleDescription } from "#core/fill-pr-template-core.js";
