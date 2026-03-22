/**
 * Generate PR title and filled template body. Heavy lifting for auto-PR workflow.
 *
 * Requires env: COMMITS (path), FILES (path), GITHUB_OUTPUT, GITHUB_WORKSPACE,
 * PR_TEMPLATE_PATH, AUTO_PR_HOW_TO_TEST. For 2+ commits: AUTO_PR_AI_PROVIDER (optional),
 * AUTO_PR_AI_OLLAMA_MODEL (optional when provider is ollama).
 *
 * Parses commits to count semantic commits. For 1: FillPrTemplate only.
 * For 2+: LanguageModel (AI provider) generates title and description via generateObject, then FillPrTemplate with override.
 *
 * Outputs to GITHUB_OUTPUT: title, body_file (path to filled template)
 *
 * Run: npx tsx src/workflow/auto-pr-generate-content.ts (or: node dist/workflow/auto-pr-generate-content.js)
 */

import { Duration, Effect, FileSystem, Layer, Option, Path, Schedule, Schema } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import {
	type AutoPrConfigError,
	AutoPrPlatformLayer,
	aiProviderLayerFromConfig,
	appendGhOutput,
	buildDescriptionPrompt,
	buildGenerateContentGhEntries,
	FillPrTemplateValidationError,
	GeneratePrContentConfig,
	GeneratePrContentConfigLayer,
	getPrDescriptionPromptPath,
	NoSemanticCommitsError,
	ParseError,
	runMain,
	TemplateRenderError,
	toError,
	UnexpectedError,
	unknownToMessage,
} from "#auto-pr";
import type { CommitInfo } from "#lib/fill-pr-template-core.js";
import {
	filterMergeCommits,
	getDescriptionFromCommits,
	getDescriptionPromptText,
	getTitle as getTitleFromCommits,
	isValidConventionalTitle,
	parseCommits,
	parseFilesContent,
	renderBody as renderBodyCore,
	validateTitleDescription,
} from "#lib/fill-pr-template-core.js";

// ─── Schema ──────────────────────────────────────────────────────────────────

/** Schema for structured AI output: PR title and description. */
const TitleDescriptionSchema = Schema.Struct({
	title: Schema.String,
	description: Schema.String,
});

// ─── Constants ────────────────────────────────────────────────────────────

const BODY_FILE_NAME = "pr-body.md";
const MAX_AI_ATTEMPTS = 5;
const RETRY_DELAY_MS = 3000;

function makeRetrySchedule(delayMs: number) {
	return Schedule.recurs(MAX_AI_ATTEMPTS - 1).pipe(
		Schedule.addDelay(() =>
			Effect.logWarning({
				event: "generate_pr_content",
				status: "ai_retry",
				message: "Title invalid or AI failed, retrying in 3s...",
			}).pipe(Effect.as(Duration.millis(delayMs))),
		),
	);
}

function getFallbackTitleAndDescription(filtered: readonly CommitInfo[]): {
	title: string;
	description: string;
} {
	const firstSubject = filtered[0]?.subject?.trim() ?? "";
	const title = isValidConventionalTitle(firstSubject) ? firstSubject : "chore: update";
	const description = getDescriptionFromCommits(filtered);
	return { title, description };
}

/** Generate title and description via LanguageModel.generateObject. Requires LanguageModel in context. */
function generateTitleAndDescription(
	prompt: string,
	filtered: readonly CommitInfo[],
	retryDelayMs: number,
): Effect.Effect<{ title: string; description: string }, unknown, LanguageModel.LanguageModel> {
	const attempt = LanguageModel.generateObject({
		prompt,
		schema: TitleDescriptionSchema,
	}).pipe(Effect.flatMap((res) => Effect.fromResult(validateTitleDescription(res.value))));
	return attempt.pipe(
		Effect.retry(makeRetrySchedule(retryDelayMs)),
		Effect.catch(() =>
			Effect.succeed(getFallbackTitleAndDescription(filtered)).pipe(
				Effect.tap(() =>
					Effect.logWarning({
						event: "generate_pr_content",
						status: "fallback",
						message: "Using fallback title after 5 invalid attempts",
					}),
				),
			),
		),
	);
}

// ─── Value-based API (no file I/O) ────────────────────────────────────────

/** Parameters for generatePrContentFromValues. All content as strings. */
export type GeneratePrContentFromValuesParams = {
	commitsContent: string;
	filesContent: string;
	templateContent: string;
	descriptionPromptText: string;
	howToTestDefault: string;
	provider: import("#auto-pr/config.js").AiProvider;
	model: string;
	/** Retry delay in ms. Use 0 for tests. Default 3000. */
	retryDelayMs?: number;
	/** Custom fetch for tests. Omit for production. */
	fetch?: typeof fetch;
};

/** Schema union for value-based errors (single source of truth). No UnexpectedError. */
export const GeneratePrContentFromValuesErrorSchema = Schema.Union([
	NoSemanticCommitsError,
	ParseError,
	TemplateRenderError,
	FillPrTemplateValidationError,
]);

/** Errors from generatePrContentFromValues (value-based, no file I/O). */
export type GeneratePrContentFromValuesError = Schema.Schema.Type<
	typeof GeneratePrContentFromValuesErrorSchema
>;

/** Errors from runGeneratePrContent (includes file I/O, AI provider config). */
export type GeneratePrContentError =
	| GeneratePrContentFromValuesError
	| UnexpectedError
	| AutoPrConfigError;

export function generatePrContentFromValues(
	params: GeneratePrContentFromValuesParams,
): Effect.Effect<
	{ title: string; body: string; count: number },
	GeneratePrContentFromValuesError,
	LanguageModel.LanguageModel
> {
	return Effect.gen(function* () {
		const {
			commitsContent,
			filesContent,
			templateContent,
			descriptionPromptText,
			howToTestDefault,
			retryDelayMs,
		} = params;

		const parseResult = parseCommits(commitsContent);
		const rawCommits = yield* Effect.fromResult(parseResult);
		const filtered = filterMergeCommits(rawCommits);
		const count = filtered.length;

		if (count === 0) {
			return yield* Effect.fail(
				new NoSemanticCommitsError({
					message:
						"No semantic commits (all merge or non-semantic). Add at least one non-merge commit before pushing.",
				}),
			);
		}

		const files = parseFilesContent(filesContent);

		let title: string;
		let descriptionOverride: string | undefined;

		if (count >= 2) {
			const commitContent = getDescriptionPromptText(filtered);
			const prompt = buildDescriptionPrompt(descriptionPromptText, commitContent);
			const result = yield* generateTitleAndDescription(
				prompt,
				filtered,
				retryDelayMs ?? RETRY_DELAY_MS,
			);
			title = result.title;
			descriptionOverride = result.description;
		} else {
			title = getTitleFromCommits(filtered);
			descriptionOverride = undefined;
		}

		const bodyResult = renderBodyCore(
			filtered,
			files,
			templateContent,
			descriptionOverride,
			howToTestDefault,
		);
		const body = yield* Effect.fromResult(bodyResult);
		return { title, body, count };
	}).pipe(
		// Defects (unexpected throws) → TemplateRenderError at boundary. Log before converting.
		Effect.catchDefect((defect) =>
			Effect.logError({
				event: "generate_pr_content",
				status: "defect",
				cause: unknownToMessage(defect),
			}).pipe(Effect.flatMap(() => Effect.fail(normalizeUnknownToGeneratePrContentError(defect)))),
		),
		// Exhaustive tag handling: known domain errors pass through; unknown normalized via Schema or fallback.
		Effect.catchTags(
			{
				NoSemanticCommitsError: (e: NoSemanticCommitsError) => Effect.fail(e),
				ParseError: (e: ParseError) => Effect.fail(e),
				TemplateRenderError: (e: TemplateRenderError) => Effect.fail(e),
				FillPrTemplateValidationError: (e: FillPrTemplateValidationError) => Effect.fail(e),
			},
			(e: unknown) => Effect.fail(normalizeUnknownToGeneratePrContentError(e)),
		),
	);
}

/** Normalize unknown (defect or non-tagged failure) to GeneratePrContentFromValuesError. Exported for tests. */
export function normalizeUnknownToGeneratePrContentError(
	e: unknown,
): GeneratePrContentFromValuesError {
	const decoded = Schema.decodeUnknownOption(GeneratePrContentFromValuesErrorSchema)(e);
	return Option.getOrElse(
		decoded,
		() =>
			new TemplateRenderError({
				message: "Unexpected failure",
				cause: toError(e),
			}),
	);
}

// ─── Main pipeline ───────────────────────────────────────────────────────

export function runGeneratePrContent(config: {
	commits: string;
	files: string;
	ghOutput: string;
	workspace: string;
	templatePath: string;
	provider: import("#auto-pr/config.js").AiProvider;
	model: string;
	howToTestDefault: string;
	/** Retry delay in ms. Use 0 for tests to avoid timeouts. Default 3000. */
	retryDelayMs?: number;
	/** Custom fetch for tests. Omit for production. */
	fetch?: typeof fetch;
}): Effect.Effect<void, GeneratePrContentError, FileSystem.FileSystem | Path.Path> {
	const toUnexpected = (ctx: string) => (e: unknown) =>
		new UnexpectedError({ cause: `${ctx}: ${unknownToMessage(e)}` });

	return Effect.gen(function* () {
		const {
			commits,
			files,
			ghOutput,
			workspace,
			templatePath,
			provider,
			model,
			howToTestDefault,
			retryDelayMs,
		} = config;
		const pathApi = yield* Path.Path;
		const fs = yield* FileSystem.FileSystem;

		const [commitsContent, filesContent, templateContent, descriptionPromptText] =
			yield* Effect.all([
				fs.readFileString(commits).pipe(Effect.mapError(toUnexpected("commits"))),
				fs.readFileString(files).pipe(Effect.mapError(toUnexpected("files"))),
				fs.readFileString(templatePath).pipe(Effect.mapError(toUnexpected("template"))),
				getPrDescriptionPromptPath().pipe(
					Effect.mapError(toUnexpected("getPrDescriptionPromptPath")),
					Effect.flatMap((p) =>
						fs.readFileString(p).pipe(Effect.mapError(toUnexpected("pr-description.txt"))),
					),
				),
			]);

		const generateLayer = Layer.mergeAll(
			AutoPrPlatformLayer,
			aiProviderLayerFromConfig(
				{ provider, model },
				config.fetch !== undefined ? { fetch: config.fetch } : undefined,
			),
		);
		const { title, body, count } = yield* generatePrContentFromValues({
			commitsContent,
			filesContent,
			templateContent,
			descriptionPromptText,
			howToTestDefault,
			provider,
			model,
			...(retryDelayMs !== undefined && { retryDelayMs }),
			...(config.fetch !== undefined && { fetch: config.fetch }),
		}).pipe(Effect.provide(generateLayer));

		const bodyPath = pathApi.join(workspace, BODY_FILE_NAME);
		yield* fs.writeFileString(bodyPath, body).pipe(Effect.mapError(toUnexpected("write body")));

		const entriesResult = buildGenerateContentGhEntries(title, bodyPath);
		const entries = yield* Effect.fromResult(entriesResult).pipe(
			Effect.mapError(
			(e) =>
				new UnexpectedError({
						cause: `GITHUB_OUTPUT: ${unknownToMessage(e)}`,
					}),
			),
		);
		yield* appendGhOutput(ghOutput, entries).pipe(Effect.mapError(toUnexpected("append GhOutput")));
		yield* Effect.log({
			event: "generate_pr_content",
			status: "success",
			count,
			mode: count >= 2 ? "ai" : "single_commit",
		});
	}).pipe(
		Effect.catchDefect((defect) =>
			Effect.logError({
				event: "generate_pr_content",
				status: "defect",
				cause: unknownToMessage(defect),
			}).pipe(Effect.flatMap(() => Effect.fail(toUnexpected("defect")(defect)))),
		),
	);
}

// ─── Entry ──────────────────────────────────────────────────────────────────

const GeneratePrContentLayer = AutoPrPlatformLayer;

const program = Effect.gen(function* () {
	const config = yield* GeneratePrContentConfig;
	const params = {
		commits: config.commits,
		files: config.files,
		ghOutput: config.ghOutput,
		workspace: config.workspace,
		templatePath: config.templatePath,
		provider: config.provider,
		model: config.model,
		howToTestDefault: config.howToTestDefault,
	};
	yield* runGeneratePrContent(params).pipe(Effect.provide(GeneratePrContentLayer));
}).pipe(Effect.provide(GeneratePrContentConfigLayer));

if (import.meta.main) {
	runMain(program, "generate_pr_content_failed");
}
