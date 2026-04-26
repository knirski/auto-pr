/**
 * Generate PR title and filled template body. Heavy lifting for auto-PR workflow.
 *
 * Requires env: GITHUB_WORKSPACE, DEFAULT_BRANCH, BRANCH. Uses GitContext to fetch commit log and diff data directly.
 * Optional: `AUTO_PR_EXISTING_PR_TITLE` (non-empty) or best-effort `gh pr view <BRANCH> --json title` supplies the current PR title for multi-commit AI prompts (continuity when updating an open PR).
 * PR template is `.github/PULL_REQUEST_TEMPLATE.md` under workspace (edit that file for “how to test” copy). For 2+ commits: `AUTO_PR_AI_PROVIDER` (optional; default `local`) and provider-specific env (see `config.ts`).
 *
 * Parses commits to count semantic commits. For 1: FillPrTemplate only. For 2+: `LanguageModel.generateText`, then
 * `parseFirstJsonObject` + {@link TitleDescriptionSchema} (see `decodeTitleDescriptionFromAssistantText`). Retries, then
 * commit-derived fallback. Why not `generateObject`: see `docs/ARCHITECTURE.md` and `docs/INTEGRATION.md` (AI providers).
 *
 * Writes `{GITHUB_WORKSPACE}/pr-title.txt` and `{GITHUB_WORKSPACE}/pr-body.md`.
 *
 * This repo: bun run generate-content · installed: npx auto-pr-generate-content
 */

import type { Redacted } from "effect";
import {
	Duration,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	pipe,
	Result,
	Schedule,
	Schema,
} from "effect";
import type { AiError } from "effect/unstable/ai";
import { LanguageModel } from "effect/unstable/ai";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import {
	type AiProvider,
	AutoPrConfigError,
	AutoPrPlatformLayer,
	aiProviderLayerFromConfig,
	buildDescriptionPrompt,
	ChildProcessSpawnerLayer,
	DescriptionParseError,
	DiffToolkit,
	formatError,
	GeneratePrContentConfig,
	GeneratePrContentConfigLayer,
	GitContext,
	GitContextLive,
	getPrDescriptionPromptPath,
	isBlank,
	isTransientAiError,
	makeDiffToolkitLayer,
	NoSemanticCommitsError,
	ParseError,
	PR_BODY_FILE_NAME,
	PR_TITLE_FILE_NAME,
	runCommand,
	runMain,
	TemplateRenderError,
	toError,
	UnexpectedError,
	unknownToMessage,
} from "#auto-pr";
import type { CommitInfo } from "#core/fill-pr-template-core.js";
import {
	filterMergeCommits,
	fitConventionalTitleToLengthLimit,
	getDescription,
	getDescriptionPromptText,
	getTitle as getTitleFromCommits,
	isWithinLengthLimit,
	matchesConventionalTitleFormat,
	parseCommits,
	parseFilesContent,
	renderBody as renderBodyCore,
} from "#core/fill-pr-template-core.js";
import { parseFirstJsonObject } from "#core/parse-model-json.js";
import { truncateForLog } from "#core/string.js";

// ─── Schema ──────────────────────────────────────────────────────────────────

/** Schema for structured AI output: PR title plus structured review sections. */
const TitleDescriptionSchema = Schema.Struct({
	title: Schema.String,
	motivation: Schema.Array(Schema.String),
	benefits: Schema.Array(Schema.String),
	risks: Schema.Array(Schema.String),
	notesForReviewers: Schema.String,
});

type TitleDescription = Schema.Schema.Type<typeof TitleDescriptionSchema>;

/** Parse assistant reply → JSON → {@link TitleDescriptionSchema}. */
function decodeTitleDescriptionFromAssistantText(
	text: string,
): Effect.Effect<TitleDescription, unknown, never> {
	return pipe(
		Effect.fromResult(parseFirstJsonObject(text)),
		Effect.flatMap(Schema.decodeUnknownEffect(TitleDescriptionSchema)),
	);
}

function logAndValidateTitleDescription(
	raw: TitleDescription,
	provider: AiProvider,
	model: string,
): Effect.Effect<{ title: string; description: string }, DescriptionParseError> {
	return Effect.gen(function* () {
		const titleTrimmed = raw.title.trim();
		yield* Effect.log({
			event: "generate_pr_content",
			step: "model_response",
			status: "parsed",
			provider,
			model,
			title: raw.title,
			title_chars: raw.title.length,
			title_conventional_format: matchesConventionalTitleFormat(titleTrimmed),
			title_within_length_limit: isWithinLengthLimit(titleTrimmed),
			motivation_count: raw.motivation.length,
			motivation: raw.motivation.map((s) => truncateForLog(s, 200)),
			benefits_count: raw.benefits.length,
			benefits: raw.benefits.map((s) => truncateForLog(s, 200)),
			risks_count: raw.risks.length,
			risks: raw.risks.map((risk) => truncateForLog(risk, 200)),
			notes_for_reviewers_chars: raw.notesForReviewers.length,
			notes_for_reviewers: truncateForLog(raw.notesForReviewers, 500),
		});
		const validated = yield* Effect.fromResult(validateGeneratedContent(raw));
		if (titleTrimmed !== validated.title) {
			yield* Effect.log({
				event: "generate_pr_content",
				step: "validation",
				status: "title_shortened",
				provider,
				model,
				title_chars_before: titleTrimmed.length,
				title_chars_after: validated.title.length,
			});
		}
		yield* Effect.log({
			event: "generate_pr_content",
			step: "validation",
			status: "ok",
			provider,
			model,
			title_chars: validated.title.length,
			description_chars: validated.description.length,
		});
		return validated;
	});
}

// ─── Constants ────────────────────────────────────────────────────────────

const MAX_AI_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY = Duration.seconds(3);

const GhPrViewTitleSchema = Schema.Struct({
	title: Schema.String,
});

function parseExistingPrTitleOutput(stdout: string): Effect.Effect<Option.Option<string>, never> {
	const trimmed = stdout.trim();
	if (trimmed === "") {
		return Effect.succeed(Option.none());
	}

	return Effect.gen(function* () {
		const parsed = yield* Effect.fromResult(parseFirstJsonObject(trimmed)).pipe(
			Effect.map(Option.some),
			Effect.catch((e: Error) =>
				Effect.logWarning({
					event: "generate_pr_content",
					step: "existing_pr_title",
					status: "parse_failed",
					message: e.message,
				}).pipe(Effect.as(Option.none())),
			),
		);
		if (Option.isNone(parsed)) {
			return Option.none();
		}

		const decoded = yield* Schema.decodeUnknownEffect(GhPrViewTitleSchema)(parsed.value).pipe(
			Effect.map(Option.some),
			Effect.catch((e: unknown) =>
				Effect.logWarning({
					event: "generate_pr_content",
					step: "existing_pr_title",
					status: "schema_failed",
					message: Schema.isSchemaError(e) ? e.message : String(e),
				}).pipe(Effect.as(Option.none())),
			),
		);
		if (Option.isNone(decoded)) {
			return Option.none();
		}

		const title = decoded.value.title.trim();
		return title === "" ? Option.none() : Option.some(title);
	});
}

/** Env `AUTO_PR_EXISTING_PR_TITLE` wins; else best-effort `gh pr view` (failures → no title). */
export function resolveExistingPrTitleForPrompt(input: {
	readonly workspace: string;
	readonly branch: string;
}): Effect.Effect<Option.Option<string>, never, ChildProcessSpawner> {
	return Effect.gen(function* () {
		const fromEnv = yield* Effect.sync(() => (process.env.AUTO_PR_EXISTING_PR_TITLE ?? "").trim());
		if (fromEnv !== "") {
			yield* Effect.log({
				event: "generate_pr_content",
				step: "existing_pr_title",
				source: "env",
				title_chars: fromEnv.length,
			});
			return Option.some(fromEnv);
		}

		const stdout = yield* runCommand(
			"gh",
			["pr", "view", input.branch, "--json", "title"],
			input.workspace,
		).pipe(Effect.catch(() => Effect.succeed("")));

		const titleOpt = yield* parseExistingPrTitleOutput(stdout);
		if (Option.isNone(titleOpt)) return Option.none();

		yield* Effect.log({
			event: "generate_pr_content",
			step: "existing_pr_title",
			source: "gh",
			title_chars: titleOpt.value.length,
		});
		return titleOpt;
	});
}

function normalizeRiskItems(risks: readonly string[]): readonly string[] {
	return risks.map((risk) => risk.trim().replace(/^-+\s*/, "")).filter((risk) => !isBlank(risk));
}

function normalizeBulletItems(items: readonly string[]): readonly string[] {
	return items.map((s) => s.trim().replace(/^-+\s*/, "")).filter((s) => !isBlank(s));
}

/** Callers must pre-normalize all array fields via {@link normalizeBulletItems} / {@link normalizeRiskItems}. */
function buildDescriptionBlock(value: {
	motivation: readonly string[];
	benefits: readonly string[];
	risks: readonly string[];
	notesForReviewers: string;
}): string {
	const sections = [`### Motivation\n${value.motivation.map((s) => `- ${s}`).join("\n")}`];
	if (value.benefits.length > 0) {
		sections.push(`### Benefits\n${value.benefits.map((s) => `- ${s}`).join("\n")}`);
	}
	sections.push(`### Risks\n${value.risks.map((risk) => `- ${risk}`).join("\n")}`);
	const notes = value.notesForReviewers.trim();
	if (!isBlank(notes)) {
		sections.push(`### Notes for reviewers\n${notes}`);
	}
	return sections.join("\n\n");
}

function validateGeneratedContent(
	value: TitleDescription,
): Result.Result<{ title: string; description: string }, DescriptionParseError> {
	const { motivation, benefits, notesForReviewers } = value;
	return pipe(
		fitConventionalTitleToLengthLimit(value.title),
		Result.flatMap((title) => {
			const normalizedMotivation = normalizeBulletItems(motivation);
			if (normalizedMotivation.length === 0) {
				return Result.fail(new DescriptionParseError({ cause: "motivation is empty" }));
			}
			const normalizedBenefits = normalizeBulletItems(benefits);
			const normalizedRisks = normalizeRiskItems(value.risks);
			if (normalizedRisks.length === 0) {
				return Result.fail(new DescriptionParseError({ cause: "risks are empty" }));
			}
			const description = buildDescriptionBlock({
				motivation: normalizedMotivation,
				benefits: normalizedBenefits,
				risks: normalizedRisks,
				notesForReviewers,
			});
			if (isBlank(description)) {
				return Result.fail(new DescriptionParseError({ cause: "description is empty" }));
			}
			return Result.succeed({ title, description });
		}),
	);
}

function makeRetrySchedule(delay: Duration.Duration) {
	const delayMs = Duration.toMillis(delay);
	const delayLabel = delayMs >= 1000 ? `${delayMs / 1000}s` : `${delayMs}ms`;
	return Schedule.recurs(MAX_AI_ATTEMPTS - 1).pipe(
		Schedule.addDelay(() =>
			Effect.logWarning({
				event: "generate_pr_content",
				status: "ai_retry",
				message: `Title invalid or AI failed, retrying in about ${delayLabel}...`,
			}).pipe(Effect.as(delay)),
		),
		// Effect v4 jitter keeps the delay within 80%-120%, so the log remains approximate.
		Schedule.jittered,
	);
}

function getFallbackTitleAndDescription(filtered: readonly CommitInfo[]): {
	title: string;
	description: string;
} {
	const firstSubject = filtered[0]?.subject?.trim() ?? "";
	const title = Result.match(fitConventionalTitleToLengthLimit(firstSubject), {
		onSuccess: (t) => t,
		onFailure: () => "chore: update",
	});
	// Use each commit's description (body excerpt, or subject-after-colon) as a separate bullet.
	// This is more readable than one blob of joined bodies.
	const bullets = filtered
		.map((c) => getDescription(c))
		.filter((s) => !isBlank(s))
		.slice(0, 8);
	const motivation = bullets.length > 0 ? bullets : [firstSubject];
	const description = buildDescriptionBlock({
		motivation,
		benefits: [],
		risks: ["AI description unavailable — review changed files directly for risk assessment."],
		notesForReviewers: "",
	});
	return { title, description };
}

/** Generate title and description via `generateText` + DiffToolkit + JSON parse + schema validation. */
function generateTitleAndDescriptionWithToolkit(
	prompt: string,
	filtered: readonly CommitInfo[],
	retryDelay: Duration.Duration,
	provider: AiProvider,
	model: string,
) {
	return Effect.gen(function* () {
		yield* Effect.log({
			event: "generate_pr_content",
			step: "ai_query",
			status: "start",
			provider,
			model,
			prompt_chars: prompt.length,
		});
		const res = yield* LanguageModel.generateText({ prompt, toolkit: DiffToolkit });
		yield* Effect.log({
			event: "generate_pr_content",
			step: "token_usage",
			provider,
			model,
			prompt_tokens: res.usage.inputTokens.total ?? null,
			completion_tokens: res.usage.outputTokens.total ?? null,
			total_tokens:
				res.usage.inputTokens.total != null && res.usage.outputTokens.total != null
					? res.usage.inputTokens.total + res.usage.outputTokens.total
					: null,
		});
		const raw = yield* decodeTitleDescriptionFromAssistantText(res.text);
		return yield* logAndValidateTitleDescription(raw, provider, model);
	}).pipe(
		Effect.tapError((e) =>
			Effect.logWarning({
				event: "generate_pr_content",
				step: e instanceof DescriptionParseError ? "validation" : "ai_query",
				status: "failed",
				provider,
				model,
				reason: formatError(e),
			}),
		),
		Effect.retry(makeRetrySchedule(retryDelay)),
		Effect.catchIf(isTransientAiError, () =>
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

// ─── GitContext-based API ─────────────────────────────────────────────────

/** Parameters for generatePrContent. Uses GitContext instead of file content. */
export type GeneratePrContentParams = {
	baseRef: string;
	headRef: string;
	templateContent: string;
	descriptionPromptText: string;
	provider: AiProvider;
	model: string;
	retryDelay?: Duration.Duration;
	/** Current PR title when updating an open PR (multi-commit AI path only). */
	existingPrTitle?: string;
};

export function generatePrContent(params: GeneratePrContentParams) {
	return Effect.gen(function* () {
		const { baseRef, headRef, templateContent, descriptionPromptText, retryDelay } = params;
		const git = yield* GitContext;

		// Fetch git data via GitContext
		const toGitError = (op: string) => (e: Error) =>
			new UnexpectedError({ cause: `${op}: ${e.message}` });
		const logOutput = yield* git
			.getLog(baseRef, headRef)
			.pipe(Effect.mapError(toGitError("git log")));
		const filesOutput = yield* git
			.getChangedFiles(baseRef, headRef)
			.pipe(Effect.mapError(toGitError("git diff --name-only")));
		const diffStatOutput = yield* git
			.getDiffStat(baseRef, headRef)
			.pipe(Effect.mapError(toGitError("git diff --stat")));

		// Parse (pure core)
		const parseResult = parseCommits(logOutput);
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

		const files = parseFilesContent(filesOutput);

		let title: string;
		let descriptionOverride: string | undefined;

		if (count >= 2) {
			const commitContent = getDescriptionPromptText(filtered);
			const prompt = buildDescriptionPrompt(
				descriptionPromptText,
				commitContent,
				diffStatOutput,
				params.existingPrTitle,
			);
			const delay = retryDelay ?? DEFAULT_RETRY_DELAY;
			const result = yield* generateTitleAndDescriptionWithToolkit(
				prompt,
				filtered,
				delay,
				params.provider,
				params.model,
			);
			title = result.title;
			descriptionOverride = result.description;
		} else {
			title = getTitleFromCommits(filtered);
			descriptionOverride = undefined;
		}

		const bodyResult = renderBodyCore(filtered, files, templateContent, descriptionOverride, title);
		const body = yield* Effect.fromResult(bodyResult);
		return { title, body, count };
	}).pipe(
		Effect.catchDefect((defect) =>
			Effect.logError({
				event: "generate_pr_content",
				status: "defect",
				cause: unknownToMessage(defect),
			}).pipe(Effect.flatMap(() => Effect.fail(normalizeUnknownToGeneratePrContentError(defect)))),
		),
		Effect.catchTags(
			{
				NoSemanticCommitsError: (e: NoSemanticCommitsError) => Effect.fail(e),
				ParseError: (e: ParseError) => Effect.fail(e),
				TemplateRenderError: (e: TemplateRenderError) => Effect.fail(e),
				AiError: (e: AiError.AiError) =>
					!isTransientAiError(e)
						? Effect.fail(
								new AutoPrConfigError({
									missing: [
										`AI provider authentication/config error [${e.reason._tag}]: ${e.message}. Check AUTO_PR_AI_OPENAI_COMPAT_URL and credentials.`,
									],
								}),
							)
						: Effect.fail(normalizeUnknownToGeneratePrContentError(e)),
			},
			(e: unknown) => Effect.fail(normalizeUnknownToGeneratePrContentError(e)),
		),
	);
}

/** Schema union for generate-content errors (single source of truth). No UnexpectedError. */
const GeneratePrContentErrorSchema = Schema.Union([
	NoSemanticCommitsError,
	ParseError,
	TemplateRenderError,
]);

/** Errors from runGeneratePrContent (includes file I/O, AI provider config). */
export type GeneratePrContentError =
	| NoSemanticCommitsError
	| ParseError
	| TemplateRenderError
	| UnexpectedError
	| AutoPrConfigError;

/** Normalize unknown (defect or non-tagged failure) to a GeneratePrContentError. Exported for tests. */
export function normalizeUnknownToGeneratePrContentError(
	e: unknown,
): NoSemanticCommitsError | ParseError | TemplateRenderError {
	const decoded = Schema.decodeUnknownOption(GeneratePrContentErrorSchema)(e);
	return Option.getOrElse(
		decoded,
		() =>
			new TemplateRenderError({
				message: "Unexpected failure",
				cause: toError(e).message,
			}),
	);
}

// ─── Main pipeline ───────────────────────────────────────────────────────

export function runGeneratePrContent(config: {
	defaultBranch: string;
	branch: string;
	workspace: string;
	templatePath: string;
	provider: AiProvider;
	model: string;
	/** Required when `provider` is `github-models` (GitHub Models API). */
	ghToken?: Redacted.Redacted<string>;
	/** When `provider` is `local` (OpenAI-compatible HTTP; e.g. llama.cpp). */
	openaiCompatUrl?: string;
	openaiCompatApiKey?: Redacted.Redacted<string>;
	/** Delay between AI retry attempts. Use `Duration.zero` in tests. Default 3s. */
	retryDelay?: Duration.Duration;
	/** Custom fetch for tests (OpenAI `POST …/chat/completions`). Omit for production. */
	fetch?: typeof fetch;
}): Effect.Effect<void, GeneratePrContentError, FileSystem.FileSystem | Path.Path> {
	const toUnexpected = (ctx: string) => (e: unknown) =>
		new UnexpectedError({ cause: `${ctx}: ${unknownToMessage(e)}` });

	return Effect.gen(function* () {
		const {
			defaultBranch,
			branch,
			workspace,
			templatePath,
			provider,
			model,
			retryDelay,
			ghToken,
			openaiCompatUrl,
			openaiCompatApiKey,
		} = config;
		const pathApi = yield* Path.Path;
		const fs = yield* FileSystem.FileSystem;

		const baseRef = `origin/${defaultBranch}`;

		const [templateContent, descriptionPromptText] = yield* Effect.all([
			fs.readFileString(templatePath).pipe(Effect.mapError(toUnexpected("template"))),
			getPrDescriptionPromptPath().pipe(
				Effect.mapError(toUnexpected("getPrDescriptionPromptPath")),
				Effect.flatMap((p) =>
					fs.readFileString(p).pipe(Effect.mapError(toUnexpected("pr-description.txt"))),
				),
			),
		]);

		const aiLayer = aiProviderLayerFromConfig(
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
		);

		const gitLayer = GitContextLive(workspace).pipe(Layer.provide(ChildProcessSpawnerLayer));
		const toolkitLayer = makeDiffToolkitLayer(baseRef, branch).pipe(Layer.provide(gitLayer));

		const generateLayer = Layer.mergeAll(AutoPrPlatformLayer, aiLayer, gitLayer, toolkitLayer);

		const existingPrTitleOpt = yield* resolveExistingPrTitleForPrompt({
			workspace,
			branch,
		}).pipe(Effect.provide(ChildProcessSpawnerLayer));

		const existingPrTitle = Option.isSome(existingPrTitleOpt)
			? existingPrTitleOpt.value
			: undefined;

		const { title, body, count } = yield* generatePrContent({
			baseRef,
			headRef: branch,
			templateContent,
			descriptionPromptText,
			provider,
			model,
			...(retryDelay !== undefined && { retryDelay }),
			...(existingPrTitle !== undefined && { existingPrTitle }),
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

const program = Effect.gen(function* () {
	const config = yield* GeneratePrContentConfig;
	const params = {
		defaultBranch: config.defaultBranch,
		branch: config.branch,
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
	yield* runGeneratePrContent(params).pipe(Effect.provide(AutoPrPlatformLayer));
}).pipe(Effect.provide(GeneratePrContentConfigLayer));

/* c8 ignore next 3 */
if (import.meta.main) {
	runMain(program, "generate_pr_content_failed");
}
