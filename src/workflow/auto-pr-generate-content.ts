/**
 * Generate PR title and filled template body. Heavy lifting for auto-PR workflow.
 *
 * Requires env: GITHUB_WORKSPACE, DEFAULT_BRANCH, BRANCH. Uses GitContext to fetch commit log and diff data directly.
 * Optional config `existingPrTitle` or best-effort PullRequestClient lookup supplies the current PR title for multi-commit AI prompts (continuity when updating an open PR).
 * PR template is `.github/PULL_REQUEST_TEMPLATE.md` under workspace (edit that file for “how to test” copy). For 2+ commits: `AUTO_PR_AI_PROVIDER` (optional; default `local`) and provider-specific env (see `config.ts`).
 *
 * Parses commits to count semantic commits. For 1: FillPrTemplate only. For 2+: `LanguageModel.generateText`, then
 * `parseTitleDescriptionFromAssistantText` (JSON extraction + Schema decode in core). Retries, then
 * commit-derived fallback. Why not `generateObject`: see `docs/ARCHITECTURE.md` and `docs/INTEGRATION.md` (AI providers).
 *
 * Writes `{GITHUB_WORKSPACE}/pr-title.txt` and `{GITHUB_WORKSPACE}/pr-body.md`.
 *
 * This repo: bun run generate-content · installed: npx auto-pr-generate-content
 */

import {
	Cause,
	Duration,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Match,
	Option,
	Path,
	Redacted,
	Result,
	Schedule,
	Schema,
} from "effect";
import type { AiError } from "effect/unstable/ai";
import { Chat } from "effect/unstable/ai";
import {
	type AiProvider,
	type AiProviderConfig,
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
	isTransientAiError,
	makeDiffToolkitLayer,
	NoSemanticCommitsError,
	ParseError,
	PR_BODY_FILE_NAME,
	PR_TITLE_FILE_NAME,
	runMain,
	TemplateRenderError,
	UnexpectedError,
	unknownToMessage,
} from "#auto-pr";
import { PullRequestClient } from "#auto-pr/live/pull-request-client.js";
import type { CommitInfo } from "#core/fill-pr-template-core.js";
import {
	filterMergeCommits,
	getDescriptionPromptText,
	getTitle as getTitleFromCommits,
	isWithinLengthLimit,
	matchesConventionalTitleFormat,
	parseCommits,
	parseFilesContent,
	renderBody as renderBodyCore,
} from "#core/fill-pr-template-core.js";
import {
	getFallbackTitleAndDescription,
	validateGeneratedContent,
} from "#core/generated-content.js";
import { truncateForLog } from "#core/string.js";
import {
	parseTitleDescriptionFromAssistantText,
	type TitleDescription,
} from "#core/title-description.js";

/** Parse assistant reply text through the pure core parser. */
function decodeTitleDescriptionFromAssistantText(
	text: string,
): Effect.Effect<TitleDescription, DescriptionParseError, never> {
	return Effect.fromResult(parseTitleDescriptionFromAssistantText(text));
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
const MIN_AI_TOOL_ROUNDS = 2;
const DEFAULT_MAX_AI_TOOL_ROUNDS = 6;
const MAX_AI_TOOL_ROUNDS = 12;
const MIN_AI_TOKEN_BUDGET = 4_000;
const MAX_AI_TOKEN_BUDGET = 40_000;
const DEFAULT_AI_TOKEN_BUDGET = 12_000;
const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;
const CONTINUE_WITH_OPTIONAL_TOOLS_PROMPT =
	"Continue from prior context and tool results. Decide whether you need more tool calls. When you are ready, return only the final JSON object with keys title, motivation, benefits, risks, and notesForReviewers.";
const REPAIR_JSON_OUTPUT_PROMPT =
	'Your previous response did not validate. Return only one JSON object that matches exactly {"title": string, "motivation": string[], "benefits": string[], "risks": string[], "notesForReviewers": string}. No markdown, no prose.';

type AiIterationLimits = {
	readonly toolRoundLimit: number;
	readonly tokenBudget: number;
};

/** Configured title wins; else best-effort PR lookup (failures -> no title). */
export function resolveExistingPrTitleForPrompt(input: {
	readonly branch: string;
	readonly existingPrTitle?: string;
}): Effect.Effect<Option.Option<string>, never, PullRequestClient> {
	return Effect.gen(function* () {
		const fromConfig = input.existingPrTitle?.trim() ?? "";
		if (fromConfig !== "") {
			yield* Effect.log({
				event: "generate_pr_content",
				step: "existing_pr_title",
				source: "config",
				title_chars: fromConfig.length,
			});
			return Option.some(fromConfig);
		}

		const prClient = yield* PullRequestClient;
		const prOpt = yield* prClient.findByBranch(input.branch).pipe(
			Effect.catch((error) =>
				Effect.logWarning({
					event: "generate_pr_content",
					step: "existing_pr_title",
					status: "lookup_failed",
					message: formatError(error),
				}).pipe(Effect.as(Option.none())),
			),
		);
		return yield* Option.match(prOpt, {
			onNone: () => Effect.succeed(Option.none()),
			onSome: (prInfo) => {
				const title = prInfo.title?.trim() ?? "";
				if (title === "") return Effect.succeed(Option.none());
				return Effect.log({
					event: "generate_pr_content",
					step: "existing_pr_title",
					source: "pull_request_client",
					title_chars: title.length,
				}).pipe(Effect.as(Option.some(title)));
			},
		});
	});
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

function logTokenUsage(input: {
	readonly provider: AiProvider;
	readonly model: string;
	readonly round: number;
	readonly promptTokens: number | null;
	readonly completionTokens: number | null;
}) {
	return Effect.log({
		event: "generate_pr_content",
		step: "token_usage",
		provider: input.provider,
		model: input.model,
		round: input.round,
		prompt_tokens: input.promptTokens,
		completion_tokens: input.completionTokens,
		total_tokens:
			input.promptTokens != null && input.completionTokens != null
				? input.promptTokens + input.completionTokens
				: null,
	});
}

function clampNumber(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function estimateTokensFromText(text: string): number {
	return Math.max(1, Math.ceil(text.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN));
}

function normalizeTokenCount(reported: number | null, fallbackText: string): number {
	return reported ?? estimateTokensFromText(fallbackText);
}

function computeAiIterationLimits(input: {
	readonly commitCount: number;
	readonly changedFileCount: number;
	readonly promptChars: number;
	readonly aiToolRoundLimit?: number;
	readonly aiTokenBudget?: number;
}): AiIterationLimits {
	if (input.aiToolRoundLimit !== undefined || input.aiTokenBudget !== undefined) {
		return {
			toolRoundLimit: clampNumber(
				input.aiToolRoundLimit ?? DEFAULT_MAX_AI_TOOL_ROUNDS,
				MIN_AI_TOOL_ROUNDS,
				MAX_AI_TOOL_ROUNDS,
			),
			tokenBudget: clampNumber(
				input.aiTokenBudget ?? DEFAULT_AI_TOKEN_BUDGET,
				MIN_AI_TOKEN_BUDGET,
				MAX_AI_TOKEN_BUDGET,
			),
		};
	}

	const complexityBoost =
		Math.floor(input.changedFileCount / 15) +
		Math.floor(Math.max(0, input.commitCount - 2) / 4) +
		(input.promptChars >= 12_000 ? 1 : 0);
	const toolRoundLimit = clampNumber(
		DEFAULT_MAX_AI_TOOL_ROUNDS + complexityBoost,
		MIN_AI_TOOL_ROUNDS,
		MAX_AI_TOOL_ROUNDS,
	);
	const tokenBudget = clampNumber(
		DEFAULT_AI_TOKEN_BUDGET +
			input.promptChars / TOKEN_ESTIMATE_CHARS_PER_TOKEN +
			complexityBoost * 1_000,
		MIN_AI_TOKEN_BUDGET,
		MAX_AI_TOKEN_BUDGET,
	);
	return {
		toolRoundLimit,
		tokenBudget: Math.floor(tokenBudget),
	};
}

function generateAssistantTextWithToolkit(
	prompt: string,
	provider: AiProvider,
	model: string,
	limits: AiIterationLimits,
) {
	return Effect.gen(function* () {
		const chat = yield* Chat.empty;
		type LoopState = {
			readonly round: number;
			readonly prompt: string;
			readonly totalTokensUsed: number;
			readonly lastParseError: Option.Option<DescriptionParseError>;
		};

		const toDescriptionParseError = (cause: Cause.Cause<unknown>) =>
			Result.match(Cause.findError(cause), {
				onSuccess: (error) =>
					error instanceof DescriptionParseError
						? error
						: new DescriptionParseError({ cause: formatError(error) }),
				onFailure: () => new DescriptionParseError({ cause: "failed to validate model output" }),
			});

		const failFromLastParseError = (state: LoopState) =>
			Effect.fail(
				Option.getOrElse(
					state.lastParseError,
					() =>
						new DescriptionParseError({
							cause: `no valid JSON response after ${limits.toolRoundLimit} rounds`,
						}),
				),
			);

		let state: LoopState = {
			round: 1,
			prompt,
			totalTokensUsed: 0,
			lastParseError: Option.none(),
		};

		while (state.round <= limits.toolRoundLimit) {
			const res = yield* chat.generateText({
				prompt: state.prompt,
				toolkit: DiffToolkit,
			});
			const promptTokens = normalizeTokenCount(res.usage.inputTokens.total ?? null, state.prompt);
			const completionTokens = normalizeTokenCount(res.usage.outputTokens.total ?? null, res.text);
			const totalTokensUsed = state.totalTokensUsed + promptTokens + completionTokens;
			yield* logTokenUsage({
				provider,
				model,
				round: state.round,
				promptTokens,
				completionTokens,
			});
			const text = res.text.trim();
			const toolCalls = res.toolCalls.length;
			yield* Effect.log({
				event: "generate_pr_content",
				step: "ai_query",
				status: "round_complete",
				provider,
				model,
				round: state.round,
				tool_calls: toolCalls,
				text_chars: text.length,
				finish_reason: res.finishReason,
				total_tokens_used: totalTokensUsed,
				token_budget: limits.tokenBudget,
			});

			if (totalTokensUsed > limits.tokenBudget) {
				return yield* Effect.fail(
					new DescriptionParseError({
						cause: `token budget exceeded before valid JSON response (${totalTokensUsed}/${limits.tokenBudget})`,
					}),
				);
			}

			if (text === "") {
				state = {
					...state,
					round: state.round + 1,
					prompt: CONTINUE_WITH_OPTIONAL_TOOLS_PROMPT,
					totalTokensUsed,
				};
				continue;
			}

			const validatedExit = yield* decodeTitleDescriptionFromAssistantText(res.text).pipe(
				Effect.flatMap((raw) => logAndValidateTitleDescription(raw, provider, model)),
				Effect.exit,
			);
			if (Exit.isSuccess(validatedExit)) {
				if (toolCalls === 0) {
					yield* Effect.log({
						event: "generate_pr_content",
						step: "ai_query",
						status: "ready_for_final_response",
						provider,
						model,
						round: state.round,
					});
					return validatedExit.value;
				}
				yield* Effect.logWarning({
					event: "generate_pr_content",
					step: "ai_query",
					status: "validated_text_but_tools_requested",
					provider,
					model,
					round: state.round,
				});
				state = {
					...state,
					round: state.round + 1,
					prompt: CONTINUE_WITH_OPTIONAL_TOOLS_PROMPT,
					totalTokensUsed,
				};
				continue;
			}

			const parseError = toDescriptionParseError(validatedExit.cause);
			yield* Effect.logWarning({
				event: "generate_pr_content",
				step: "validation",
				status: "failed_round_output",
				provider,
				model,
				round: state.round,
				reason: formatError(parseError),
			});
			state = {
				round: state.round + 1,
				prompt: toolCalls === 0 ? REPAIR_JSON_OUTPUT_PROMPT : CONTINUE_WITH_OPTIONAL_TOOLS_PROMPT,
				totalTokensUsed,
				lastParseError: Option.some(parseError),
			};
		}

		yield* Effect.logWarning({
			event: "generate_pr_content",
			step: "ai_query",
			status: "tool_round_limit_reached",
			provider,
			model,
			round_limit: limits.toolRoundLimit,
		});
		return yield* failFromLastParseError(state);
	});
}

/** Generate title and description via `generateText` + DiffToolkit + JSON parse + schema validation. */
function generateTitleAndDescriptionWithToolkit(
	prompt: string,
	filtered: readonly CommitInfo[],
	retryDelay: Duration.Duration,
	provider: AiProvider,
	model: string,
	limits: AiIterationLimits,
) {
	return Effect.gen(function* () {
		yield* Effect.log({
			event: "generate_pr_content",
			step: "ai_query",
			status: "start",
			provider,
			model,
			prompt_chars: prompt.length,
			tool_round_limit: limits.toolRoundLimit,
			token_budget: limits.tokenBudget,
		});
		return yield* generateAssistantTextWithToolkit(prompt, provider, model, limits);
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
	/** Trusted routing context computed by workflow/job logic (signal summary, not model output). */
	routingContext?: string;
	provider: AiProvider;
	model: string;
	retryDelay?: Duration.Duration;
	/** Optional override for max model/tool interaction rounds in a single AI attempt. */
	aiToolRoundLimit?: number;
	/** Optional override for token budget in a single AI attempt. */
	aiTokenBudget?: number;
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
				params.routingContext,
			);
			const limits = computeAiIterationLimits({
				commitCount: count,
				changedFileCount: files.length,
				promptChars: prompt.length,
				...(params.aiToolRoundLimit !== undefined
					? { aiToolRoundLimit: params.aiToolRoundLimit }
					: {}),
				...(params.aiTokenBudget !== undefined ? { aiTokenBudget: params.aiTokenBudget } : {}),
			});
			const delay = retryDelay ?? DEFAULT_RETRY_DELAY;
			const result = yield* generateTitleAndDescriptionWithToolkit(
				prompt,
				filtered,
				delay,
				params.provider,
				params.model,
				limits,
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

/** Schema union for generate-content errors (single source of truth). */
const GeneratePrContentErrorSchema = Schema.Union([
	NoSemanticCommitsError,
	ParseError,
	TemplateRenderError,
	UnexpectedError,
]);

function hasStringTag(value: unknown): value is { readonly _tag: string } {
	return (
		typeof value === "object" && value !== null && "_tag" in value && typeof value._tag === "string"
	);
}

function normalizeDecodeFailureCause(input: unknown, decodeError: unknown): string {
	if (input instanceof Error) return input.message;
	if (hasStringTag(input)) {
		return `${input._tag} did not match GeneratePrContentError: ${unknownToMessage(decodeError)}`;
	}
	return unknownToMessage(input);
}

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
): NoSemanticCommitsError | ParseError | TemplateRenderError | UnexpectedError {
	const decoded = Schema.decodeUnknownResult(GeneratePrContentErrorSchema)(e);
	return Result.match(decoded, {
		onSuccess: (error) => error,
		onFailure: (decodeError) =>
			new TemplateRenderError({
				message: "Unexpected failure",
				cause: normalizeDecodeFailureCause(e, decodeError),
			}),
	});
}

// ─── Main pipeline ───────────────────────────────────────────────────────

type RunGeneratePrContentConfigCommon = {
	defaultBranch: string;
	branch: string;
	workspace: string;
	templatePath: string;
	model: string;
	routingContext?: string;
	githubApiUrl?: string;
	ghHost?: string;
	/** Current PR title override for prompt continuity. */
	existingPrTitle?: string;
	/** Delay between AI retry attempts. Use `Duration.zero` in tests. Default 3s. */
	retryDelay?: Duration.Duration;
	/** Custom fetch for tests (OpenAI `POST …/chat/completions`). Omit for production. */
	fetch?: typeof fetch;
};

export type RunGeneratePrContentConfig =
	| (RunGeneratePrContentConfigCommon & {
			provider: "local";
			openaiCompatUrl?: string;
			openaiCompatApiKey?: Redacted.Redacted<string>;
	  })
	| (RunGeneratePrContentConfigCommon & {
			provider: "github-models";
			ghToken: Redacted.Redacted<string>;
	  });

export function runGeneratePrContentConfigFromGeneratePrContentConfig(
	config: GeneratePrContentConfig,
): RunGeneratePrContentConfig {
	const common = {
		defaultBranch: config.defaultBranch,
		branch: config.branch,
		workspace: config.workspace,
		templatePath: config.templatePath,
		model: config.model,
		...(config.routingContext !== undefined ? { routingContext: config.routingContext } : {}),
		...(config.githubApiUrl !== undefined ? { githubApiUrl: config.githubApiUrl } : {}),
		...(config.ghHost !== undefined ? { ghHost: config.ghHost } : {}),
		...(config.existingPrTitle !== undefined ? { existingPrTitle: config.existingPrTitle } : {}),
	};
	return Match.value(config).pipe(
		Match.when(
			{ provider: "local" },
			(local): RunGeneratePrContentConfig => ({
				...common,
				provider: "local",
				openaiCompatUrl: local.openaiCompatUrl,
				...(local.openaiCompatApiKey !== undefined
					? { openaiCompatApiKey: local.openaiCompatApiKey }
					: {}),
			}),
		),
		Match.when(
			{ provider: "github-models" },
			(githubModels): RunGeneratePrContentConfig => ({
				...common,
				provider: "github-models",
				ghToken: githubModels.ghToken,
			}),
		),
		Match.exhaustive,
	);
}

function buildAiProviderConfig(config: RunGeneratePrContentConfig): AiProviderConfig {
	return Match.value(config).pipe(
		Match.when(
			{ provider: "local" },
			(local): AiProviderConfig => ({
				provider: "local",
				model: local.model,
				...(local.openaiCompatUrl !== undefined ? { openaiCompatUrl: local.openaiCompatUrl } : {}),
				...(local.openaiCompatApiKey !== undefined
					? { openaiCompatApiKey: local.openaiCompatApiKey }
					: {}),
			}),
		),
		Match.when(
			{ provider: "github-models" },
			(githubModels): AiProviderConfig => ({
				provider: "github-models",
				model: githubModels.model,
				ghToken: githubModels.ghToken,
			}),
		),
		Match.exhaustive,
	);
}

export function runGeneratePrContent(
	config: RunGeneratePrContentConfig,
): Effect.Effect<void, GeneratePrContentError, FileSystem.FileSystem | Path.Path> {
	const baseRef = `origin/${config.defaultBranch}`;
	const aiLayer = aiProviderLayerFromConfig(
		buildAiProviderConfig(config),
		config.fetch !== undefined ? { fetch: config.fetch } : undefined,
	);

	const gitLayer = GitContextLive(config.workspace).pipe(Layer.provide(ChildProcessSpawnerLayer));
	const toolkitLayer = makeDiffToolkitLayer(baseRef, config.branch).pipe(Layer.provide(gitLayer));
	const prClientLayer = PullRequestClient.Live(config.workspace, {
		...(config.provider === "github-models" ? { ghToken: Redacted.value(config.ghToken) } : {}),
		...(config.githubApiUrl !== undefined ? { githubApiUrl: config.githubApiUrl } : {}),
		...(config.ghHost !== undefined ? { ghHost: config.ghHost } : {}),
	}).pipe(Layer.provide(ChildProcessSpawnerLayer));
	const liveLayer = Layer.mergeAll(
		AutoPrPlatformLayer,
		aiLayer,
		gitLayer,
		toolkitLayer,
		prClientLayer,
	);

	return runGeneratePrContentWithServices(config).pipe(Effect.provide(liveLayer));
}

/**
 * Generate PR content using services from the environment.
 *
 * This is the Tagless Final runner used by tests and higher-level composition.
 * The CLI-facing `runGeneratePrContent` only builds and provides live layers.
 */
export type RunGeneratePrContentWithServicesConfig = {
	readonly defaultBranch: string;
	readonly branch: string;
	readonly workspace: string;
	readonly templatePath: string;
	readonly provider: AiProvider;
	readonly model: string;
	readonly routingContext?: string;
	/** Current PR title override for prompt continuity. */
	readonly existingPrTitle?: string;
	/** Delay between AI retry attempts. Use `Duration.zero` in tests. Default 3s. */
	readonly retryDelay?: Duration.Duration;
};

export function runGeneratePrContentWithServices(config: RunGeneratePrContentWithServicesConfig) {
	function toUnexpected(ctx: string) {
		return (e: unknown) => new UnexpectedError({ cause: `${ctx}: ${unknownToMessage(e)}` });
	}

	return Effect.gen(function* () {
		const {
			defaultBranch,
			branch,
			workspace,
			templatePath,
			provider,
			model,
			routingContext,
			retryDelay,
			existingPrTitle: configuredExistingPrTitle,
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

		const existingPrTitleOpt = yield* resolveExistingPrTitleForPrompt({
			branch,
			...(configuredExistingPrTitle !== undefined
				? { existingPrTitle: configuredExistingPrTitle }
				: {}),
		});

		const existingPrTitle = Option.getOrUndefined(existingPrTitleOpt);

		const { title, body, count } = yield* generatePrContent({
			baseRef,
			headRef: branch,
			templateContent,
			descriptionPromptText,
			...(routingContext !== undefined ? { routingContext } : {}),
			provider,
			model,
			...(retryDelay !== undefined && { retryDelay }),
			...(existingPrTitle !== undefined && { existingPrTitle }),
		});

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

export const program = Effect.gen(function* () {
	const config = yield* GeneratePrContentConfig;
	yield* runGeneratePrContent(runGeneratePrContentConfigFromGeneratePrContentConfig(config)).pipe(
		Effect.provide(AutoPrPlatformLayer),
	);
}).pipe(Effect.provide(GeneratePrContentConfigLayer));

/* c8 ignore next 3 */
if (import.meta.main) {
	runMain(program, "generate_pr_content_failed");
}
