/**
 * Auto-PR shared module. Core (pure) + shell (Effect).
 *
 * Path aliases: #auto-pr (this), #core, #workflow/*, #tools/*
 */

export type {
	AiProvider,
	RunAutoPrConfigCommon,
	RunAutoPrConfigGithubModels,
	RunAutoPrConfigLocal,
} from "#auto-pr/config.js";
export {
	CreateOrUpdatePrConfig,
	CreateOrUpdatePrConfigLayer,
	DEFAULT_GITHUB_MODELS_MODEL,
	DEFAULT_OPENAI_COMPAT_MODEL,
	DEFAULT_OPENAI_COMPAT_URL,
	GeneratePrContentConfig,
	GeneratePrContentConfigLayer,
	RunAutoPrConfig,
	RunAutoPrConfigLayer,
} from "#auto-pr/config.js";
export { DiffToolkit, makeDiffToolkitLayer } from "#auto-pr/diff-toolkit.js";
export {
	ActLocalCiError,
	AiProviderError,
	AutoPrConfigError,
	BodyFileNotFoundError,
	DescriptionParseError,
	FillPrTemplateValidationError,
	formatError,
	isTransientAiError,
	NoSemanticCommitsError,
	ParseError,
	PullRequestBodyBlankError,
	PullRequestFailedError,
	PullRequestTitleBlankError,
	TemplateRenderError,
	UnexpectedError,
} from "#auto-pr/errors.js";
export { GitContext, GitContextLive } from "#auto-pr/git-context.js";
export type { FillPrTemplateParams } from "#auto-pr/interfaces/fill-pr-template.js";
export { FillPrTemplateParamsSchema } from "#auto-pr/interfaces/fill-pr-template.js";
export type {
	PrInfo,
	PullRequestClientService,
} from "#auto-pr/interfaces/pull-request-client.js";
export {
	type AiProviderConfig,
	aiProviderLayerFromConfig,
} from "#auto-pr/live/ai-provider.js";
export { FillPrTemplate, renderBody } from "#auto-pr/live/fill-pr-template.js";
export { PullRequestClient } from "#auto-pr/live/pull-request-client.js";
export {
	getPrDescriptionPromptPath,
	PR_BODY_FILE_NAME,
	PR_TITLE_FILE_NAME,
} from "#auto-pr/paths.js";
export {
	AutoPrLoggerLayer,
	appendGhOutput,
	ChildProcessSpawnerLayer,
	type CliMainEffect,
	cleanGitEnv,
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
export type { GhOutputValue } from "#core/gh-output.js";
export {
	buildDescriptionPrompt,
	decodeGhOutputTitle,
	formatGhOutput,
	getGhOutputValue,
	isBlank,
	isHttpError,
	isMergeCommitSubject,
	parseGhOutput,
	sanitizeForGhOutput,
} from "#core/index.js";
