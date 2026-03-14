/**
 * Auto-PR shared module. Core (pure) + shell (Effect).
 */

export {
	CreateOrUpdatePrConfig,
	CreateOrUpdatePrConfigLayer,
	GeneratePrContentConfig,
	GeneratePrContentConfigLayer,
	GetCommitsConfig,
	GetCommitsConfigLayer,
} from "./config.js";
export {
	buildDescriptionPrompt,
	filterSemanticSubjects,
	formatGhOutput,
	isBlank,
	isMergeCommitSubject,
	parseSubjects,
	sanitizeForGhOutput,
	trimOllamaResponse,
	validateDescriptionResponse,
} from "./core.js";
export {
	BodyFileNotFound,
	formatAutoPrError,
	GhPrFailed,
	NoSemanticCommits,
	OllamaHttpError,
	PrTitleBlank,
} from "./errors.js";

export { FillPrTemplate, FillPrTemplateLiveLayer } from "./live/fill-pr-template.js";

export { PR_DESCRIPTION_PROMPT_PATH } from "./prompts.js";

export {
	AutoPrLoggerLayer,
	AutoPrPlatformLayer,
	appendGhOutput,
	ChildProcessSpawnerLayer,
	runCommand,
	runMain,
} from "./shell.js";
