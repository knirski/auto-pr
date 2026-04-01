/**
 * Generate PR title and filled template body. Heavy lifting for auto-PR workflow.
 *
 * Requires env: GITHUB_WORKSPACE. Reads `commits.txt` and `files.txt` under workspace (from `get-commits`).
 * PR template is `.github/PULL_REQUEST_TEMPLATE.md` under workspace (edit that file for “how to test” copy). For 2+ commits: `AUTO_PR_AI_PROVIDER` (optional; default `local`) and provider-specific env (see `config.ts`).
 *
 * Parses commits to count semantic commits. For 1: FillPrTemplate only.
 * For 2+: LanguageModel (AI provider) generates title and description via generateObject, then FillPrTemplate with override.
 *
 * Writes `{GITHUB_WORKSPACE}/pr-title.txt` and `{GITHUB_WORKSPACE}/pr-body.md`.
 *
 * This repo: bun run generate-content · installed: npx auto-pr-generate-content
 */

import type { Redacted } from "effect";
import { Duration, Effect, FileSystem, Layer, Option, Path, Schedule, Schema } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import {
	type AiProvider,
	type AutoPrConfigError,
	AutoPrPlatformLayer,
	aiProviderLayerFromConfig,
	buildDescriptionPrompt,
	GeneratePrContentConfig,
	GeneratePrContentConfigLayer,
	getPrDescriptionPromptPath,
	NoSemanticCommitsError,
	ParseError,
	PR_BODY_FILE_NAME,
	PR_TITLE_FILE_NAME,
	runMain,
	TemplateRenderError,
	toError,
	UnexpectedError,
	unknownToMessage,
} from "#auto-pr";
import type { CommitInfo } from "#core/fill-pr-template-core.js";
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
} from "#core/fill-pr-template-core.js";

// ─── Schema ──────────────────────────────────────────────────────────────────

/** Schema for structured AI output: PR title and description. */
const TitleDescriptionSchema = Schema.Struct({
	title: Schema.String,
	description: Schema.String,
});

// ─── Constants ────────────────────────────────────────────────────────────

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
	provider: AiProvider,
	model: string,
): Effect.Effect<{ title: string; description: string }, unknown, LanguageModel.LanguageModel> {
	const singleAttempt = Effect.gen(function* () {
		yield* Effect.log({
			event: "generate_pr_content",
			step: "ai_query",
			status: "start",
			provider,
			model,
			prompt_chars: prompt.length,
		});
		const res = yield* LanguageModel.generateObject({
			prompt,
			schema: TitleDescriptionSchema,
		});
		yield* Effect.log({
			event: "generate_pr_content",
			step: "ai_query",
			status: "response_received",
			provider,
			model,
		});
		const validated = yield* Effect.fromResult(validateTitleDescription(res.value));
		yield* Effect.log({
			event: "generate_pr_content",
			step: "ai_query",
			status: "validated",
			provider,
			model,
			title_chars: validated.title.length,
			description_chars: validated.description.length,
		});
		return validated;
	});

	return singleAttempt.pipe(
		Effect.tapError((e) =>
			Effect.logWarning({
				event: "generate_pr_content",
				step: "ai_query",
				status: "attempt_failed",
				provider,
				model,
				cause: unknownToMessage(e),
			}),
		),
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
		const { commitsContent, filesContent, templateContent, descriptionPromptText, retryDelayMs } =
			params;

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
				params.provider,
				params.model,
			);
			title = result.title;
			descriptionOverride = result.description;
		} else {
			title = getTitleFromCommits(filtered);
			descriptionOverride = undefined;
		}

		const bodyResult = renderBodyCore(filtered, files, templateContent, descriptionOverride);
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
	workspace: string;
	templatePath: string;
	provider: import("#auto-pr/config.js").AiProvider;
	model: string;
	/** Required when `provider` is `github-models` (GitHub Models API). */
	ghToken?: Redacted.Redacted<string>;
	/** When `provider` is `local` (OpenAI-compatible HTTP; e.g. llama.cpp). */
	openaiCompatUrl?: string;
	openaiCompatApiKey?: Redacted.Redacted<string>;
	/** Retry delay in ms. Use 0 for tests to avoid timeouts. Default 3000. */
	retryDelayMs?: number;
	/** Custom fetch for tests (OpenAI `POST …/chat/completions`). Omit for production. */
	fetch?: typeof fetch;
}): Effect.Effect<void, GeneratePrContentError, FileSystem.FileSystem | Path.Path> {
	const toUnexpected = (ctx: string) => (e: unknown) =>
		new UnexpectedError({ cause: `${ctx}: ${unknownToMessage(e)}` });

	return Effect.gen(function* () {
		const {
			commits,
			files,
			workspace,
			templatePath,
			provider,
			model,
			retryDelayMs,
			ghToken,
			openaiCompatUrl,
			openaiCompatApiKey,
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
				{
					provider,
					model,
					...(ghToken !== undefined ? { ghToken } : {}),
					...(provider === "local"
						? {
								...(openaiCompatUrl !== undefined ? { openaiCompatUrl } : {}),
								...(openaiCompatApiKey !== undefined ? { openaiCompatApiKey } : {}),
							}
						: {}),
				},
				config.fetch !== undefined ? { fetch: config.fetch } : undefined,
			),
		);
		const { title, body, count } = yield* generatePrContentFromValues({
			commitsContent,
			filesContent,
			templateContent,
			descriptionPromptText,
			provider,
			model,
			...(retryDelayMs !== undefined && { retryDelayMs }),
			...(config.fetch !== undefined && { fetch: config.fetch }),
		}).pipe(Effect.provide(generateLayer));

		const bodyPath = pathApi.join(workspace, PR_BODY_FILE_NAME);
		const titlePath = pathApi.join(workspace, PR_TITLE_FILE_NAME);
		yield* fs
			.writeFileString(titlePath, title)
			.pipe(Effect.mapError(toUnexpected("write pr-title.txt")));
		yield* fs
			.writeFileString(bodyPath, body)
			.pipe(Effect.mapError(toUnexpected("write pr-body.md")));
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
		workspace: config.workspace,
		templatePath: config.templatePath,
		provider: config.provider,
		model: config.model,
		...(config.ghToken !== undefined ? { ghToken: config.ghToken } : {}),
		...(config.provider === "local"
			? {
					...(config.openaiCompatUrl !== undefined
						? { openaiCompatUrl: config.openaiCompatUrl }
						: {}),
					...(config.openaiCompatApiKey !== undefined
						? { openaiCompatApiKey: config.openaiCompatApiKey }
						: {}),
				}
			: {}),
	};
	yield* runGeneratePrContent(params).pipe(Effect.provide(GeneratePrContentLayer));
}).pipe(Effect.provide(GeneratePrContentConfigLayer));

if (import.meta.main) {
	runMain(program, "generate_pr_content_failed");
}
