/**
 * Re-exports from pure core. Kept for backward compatibility.
 * New code should import from #core directly.
 */

export type { GhOutputValue } from "#core/gh-output.js";
export {
	buildDescriptionPrompt,
	buildGenerateContentGhEntries,
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
	validateGenerateContentOutput,
	validateGetCommitsOutput,
} from "#core/index.js";
