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
	Duration,
	Effect,
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
import { type AiError, AiError as EffectAiError, LanguageModel } from "effect/unstable/ai";
import {
	type AiProvider,
	type AiProviderConfig,
	AiProviderError,
	AutoPrConfigError,
	AutoPrPlatformLayer,
	aiProviderLayerFromConfig,
	buildDescriptionPrompt,
	ChildProcessSpawnerLayer,
	DEFAULT_OPENAI_COMPAT_URL,
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
	type RateLimitFallbackStrategy as RateLimitFallbackStrategyName,
	runMain,
	TemplateRenderError,
	UnexpectedError,
	unknownToMessage,
} from "#auto-pr";
import { PullRequestClient } from "#auto-pr/live/pull-request-client.js";
import {
	type AiFallbackPlan,
	type AiFallbackPlanStep,
	DefaultAiFallbackPolicy,
} from "#core/ai-fallback-policy-core.js";
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
import {
	buildGithubModelFallbackChain,
	resolveLocalRunnerResources,
	selectModel,
} from "#workflow/model-routing.js";

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
const TOOL_RESULT_FOLLOWUP_MAX_ITEMS = 3;
const TOOL_RESULT_FOLLOWUP_MAX_CHARS_PER_ITEM = 4_000;

export function parseOptionalPositiveNumber(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return undefined;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isRateLimitWithRetryAfterError(error: unknown): boolean {
	const message = formatError(error).toLowerCase();
	const hasRetryAfter = message.includes("retry after");
	const isStatus429 = error instanceof AiProviderError && error.status === 429;
	const isEffectRateLimitError =
		EffectAiError.isAiError(error) && error.reason._tag === "RateLimitError";
	const hasRateLimitSignal =
		isStatus429 ||
		isEffectRateLimitError ||
		message.includes("rate limit") ||
		message.includes("ratelimit");
	return hasRateLimitSignal && (hasRetryAfter || isStatus429 || isEffectRateLimitError);
}

function resolveStrongestLocalFallbackModel(): string {
	const runnerLabel = process.env.RUNNER_LABEL;
	const repositoryVisibility = process.env.REPOSITORY_VISIBILITY;
	const cpuCount = parseOptionalPositiveNumber(process.env.LOCAL_RUNNER_CPUS);
	const memoryGb = parseOptionalPositiveNumber(process.env.LOCAL_RUNNER_MEMORY_GB);
	const runner = resolveLocalRunnerResources({
		...(runnerLabel !== undefined ? { runnerLabel } : {}),
		...(repositoryVisibility !== undefined ? { repositoryVisibility } : {}),
		...(cpuCount !== undefined ? { cpuCount } : {}),
		...(memoryGb !== undefined ? { memoryGb } : {}),
	});
	return selectModel("local", "C", undefined, {
		reasoningNeed: "high",
		requiresToolCalls: true,
		localModel: { runner },
	});
}

function buildCommitFallbackEffect(filtered: readonly CommitInfo[]) {
	return Effect.succeed(getFallbackTitleAndDescription(filtered)).pipe(
		Effect.tap(() =>
			Effect.logWarning({
				event: "generate_pr_content",
				status: "fallback",
				message: "Using fallback title after 5 invalid attempts",
			}),
		),
	);
}

type ToolResultForFollowup = {
	readonly name: string;
	readonly isFailure: boolean;
	readonly result: unknown;
};

type RateLimitFallbackStrategy = {
	readonly aiFallbackStrategy?: RateLimitFallbackStrategyName;
};

function resolveLocalRateLimitFallbackModel(): string {
	return resolveStrongestLocalFallbackModel();
}

function resolveGithubFallbackChain(input: { readonly model: string }): readonly string[] {
	return buildGithubModelFallbackChain({
		selectedModel: input.model,
		requiresToolCalls: true,
		reasoningNeed: "high",
	});
}

function resolveRateLimitFallbackPlan(input: {
	readonly selectedModel: string;
	readonly aiFallbackStrategy?: RateLimitFallbackStrategyName;
}): AiFallbackPlan {
	const githubModels = resolveGithubFallbackChain({ model: input.selectedModel });
	return DefaultAiFallbackPolicy.resolvePlan({
		selectedGithubModel: input.selectedModel,
		githubFallbackChain: githubModels,
		strongestLocalModel: resolveLocalRateLimitFallbackModel(),
		...(input.aiFallbackStrategy !== undefined ? { strategy: input.aiFallbackStrategy } : {}),
	});
}

type GeneratedTitleAndDescription = {
	readonly title: string;
	readonly description: string;
};

type AttemptRunner<R> = (
	provider: AiProvider,
	model: string,
) => Effect.Effect<GeneratedTitleAndDescription, unknown, R>;

export function runGithubFallbackModelAttempts<R>(input: {
	readonly models: readonly string[];
	readonly runAttempt: AttemptRunner<R>;
}): Effect.Effect<Option.Option<GeneratedTitleAndDescription>, unknown, R> {
	return Effect.gen(function* () {
		for (const githubFallbackModel of input.models) {
			const attempt = yield* input.runAttempt("github-models", githubFallbackModel).pipe(
				Effect.map((value) => ({ _tag: "Success" as const, value })),
				Effect.catch((error) => Effect.succeed({ _tag: "Failure" as const, error })),
			);
			if (attempt._tag === "Success") {
				yield* Effect.log({
					event: "generate_pr_content",
					status: "rate_limit_fallback_model_success",
					provider: "github-models",
					model: githubFallbackModel,
				});
				return Option.some(attempt.value);
			}
			const candidateError = attempt.error;
			if (!isTransientAiError(candidateError) || !isRateLimitWithRetryAfterError(candidateError)) {
				return yield* Effect.fail(candidateError);
			}
			yield* Effect.logWarning({
				event: "generate_pr_content",
				status: "rate_limit_fallback_model_skipped",
				provider: "github-models",
				model: githubFallbackModel,
				reason: formatError(candidateError),
			});
		}
		return Option.none<GeneratedTitleAndDescription>();
	});
}

export function executeAiFallbackPlan<R>(input: {
	readonly plan: AiFallbackPlan;
	readonly runAttempt: AttemptRunner<R>;
	readonly filtered: readonly CommitInfo[];
	readonly localFallbackLayerForModel: (
		model: string,
	) => Layer.Layer<LanguageModel.LanguageModel, unknown, never>;
}): Effect.Effect<GeneratedTitleAndDescription, unknown, R> {
	const runStepAt = (index: number): Effect.Effect<GeneratedTitleAndDescription, unknown, R> => {
		const step = input.plan.steps[index];
		if (step === undefined) return buildCommitFallbackEffect(input.filtered);
		return Match.value(step).pipe(
			Match.tag("github-model", ({ model }) =>
				runGithubFallbackModelAttempts({ models: [model], runAttempt: input.runAttempt }).pipe(
					Effect.map(Option.getOrUndefined),
				),
			),
			Match.tag("local-model", ({ model }) =>
				Effect.logWarning({
					event: "generate_pr_content",
					status: "rate_limit_fallback_local_start",
					fallback_provider: "local",
					fallback_model: model,
				}).pipe(
					Effect.flatMap(() =>
						input
							.runAttempt("local", model)
							.pipe(Effect.provide(input.localFallbackLayerForModel(model))),
					),
					Effect.map((value) => value as GeneratedTitleAndDescription | undefined),
				),
			),
			Match.tag("commit-fallback", () =>
				buildCommitFallbackEffect(input.filtered).pipe(
					Effect.map((value) => value as GeneratedTitleAndDescription | undefined),
				),
			),
			Match.exhaustive,
			Effect.flatMap((result) =>
				result !== undefined ? Effect.succeed(result) : runStepAt(index + 1),
			),
		);
	};

	return runStepAt(0);
}

function stringifyToolResultForPrompt(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function buildToolResultFollowupPrompt(
	basePrompt: string,
	toolResults: readonly ToolResultForFollowup[],
): string {
	const renderedResults = toolResults
		.slice(0, TOOL_RESULT_FOLLOWUP_MAX_ITEMS)
		.map((toolResult, index) => {
			const status = toolResult.isFailure ? "failure" : "success";
			const raw = stringifyToolResultForPrompt(toolResult.result);
			const truncated = truncateForLog(raw, TOOL_RESULT_FOLLOWUP_MAX_CHARS_PER_ITEM);
			return `Tool result ${index + 1} (${toolResult.name}, ${status}):\n${truncated}`;
		})
		.join("\n\n");

	return `${basePrompt}

Tool outputs from the previous step:
${renderedResults}

Return ONLY one JSON object matching the requested schema. Do not call tools.`;
}

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

/** Generate title and description via `generateText` + DiffToolkit + JSON parse + schema validation. */
function generateTitleAndDescriptionWithToolkit(
	prompt: string,
	filtered: readonly CommitInfo[],
	retryDelay: Duration.Duration,
	provider: AiProvider,
	model: string,
	options?: {
		readonly fetch?: typeof fetch;
		readonly fallbackStrategy?: RateLimitFallbackStrategy;
	},
) {
	const runAttempt = (attemptProvider: AiProvider, attemptModel: string) =>
		Effect.gen(function* () {
			yield* Effect.log({
				event: "generate_pr_content",
				step: "ai_query",
				status: "start",
				provider: attemptProvider,
				model: attemptModel,
				prompt_chars: prompt.length,
			});
			const firstResponse = yield* LanguageModel.generateText({ prompt, toolkit: DiffToolkit });
			yield* Effect.log({
				event: "generate_pr_content",
				step: "token_usage",
				provider: attemptProvider,
				model: attemptModel,
				prompt_tokens: firstResponse.usage.inputTokens.total ?? null,
				completion_tokens: firstResponse.usage.outputTokens.total ?? null,
				total_tokens:
					firstResponse.usage.inputTokens.total != null &&
					firstResponse.usage.outputTokens.total != null
						? firstResponse.usage.inputTokens.total + firstResponse.usage.outputTokens.total
						: null,
			});
			const toolOnlyResponse =
				firstResponse.text.trim() === "" &&
				(firstResponse.toolCalls.length > 0 || firstResponse.toolResults.length > 0);
			const finalText = yield* toolOnlyResponse
				? Effect.gen(function* () {
						yield* Effect.log({
							event: "generate_pr_content",
							step: "ai_query",
							status: "followup_start",
							provider: attemptProvider,
							model: attemptModel,
							tool_calls: firstResponse.toolCalls.length,
							tool_results: firstResponse.toolResults.length,
						});
						const followupPrompt = buildToolResultFollowupPrompt(prompt, firstResponse.toolResults);
						const followupResponse = yield* LanguageModel.generateText({
							prompt: followupPrompt,
							toolChoice: "none",
						});
						yield* Effect.log({
							event: "generate_pr_content",
							step: "token_usage_followup",
							provider: attemptProvider,
							model: attemptModel,
							prompt_tokens: followupResponse.usage.inputTokens.total ?? null,
							completion_tokens: followupResponse.usage.outputTokens.total ?? null,
							total_tokens:
								followupResponse.usage.inputTokens.total != null &&
								followupResponse.usage.outputTokens.total != null
									? followupResponse.usage.inputTokens.total +
										followupResponse.usage.outputTokens.total
									: null,
						});
						return followupResponse.text;
					})
				: Effect.succeed(firstResponse.text);
			const raw = yield* decodeTitleDescriptionFromAssistantText(finalText);
			return yield* logAndValidateTitleDescription(raw, attemptProvider, attemptModel);
		}).pipe(
			Effect.tapError((e) =>
				Effect.logWarning({
					event: "generate_pr_content",
					step: e instanceof DescriptionParseError ? "validation" : "ai_query",
					status: "failed",
					provider: attemptProvider,
					model: attemptModel,
					reason: formatError(e),
				}),
			),
			Effect.retry(makeRetrySchedule(retryDelay)),
		);

	return runAttempt(provider, model).pipe(
		Effect.catchIf(isTransientAiError, (error) => {
			if (provider !== "github-models" || !isRateLimitWithRetryAfterError(error)) {
				return buildCommitFallbackEffect(filtered);
			}
			const plan = resolveRateLimitFallbackPlan({
				selectedModel: model,
				...(options?.fallbackStrategy?.aiFallbackStrategy !== undefined
					? { aiFallbackStrategy: options.fallbackStrategy.aiFallbackStrategy }
					: {}),
			});
			const strategy = plan.strategy;
			const fallbackUrl =
				process.env.AUTO_PR_AI_OPENAI_COMPAT_URL?.trim() || DEFAULT_OPENAI_COMPAT_URL;
			const fallbackApiKey = process.env.AUTO_PR_AI_OPENAI_COMPAT_API_KEY?.trim();
			const localFallbackLayerForModel = (fallbackModel: string) =>
				aiProviderLayerFromConfig(
					{
						provider: "local",
						model: fallbackModel,
						openaiCompatUrl: fallbackUrl,
						...(fallbackApiKey === undefined || fallbackApiKey === ""
							? {}
							: { openaiCompatApiKey: Redacted.make(fallbackApiKey) }),
					},
					options?.fetch !== undefined ? { fetch: options.fetch } : undefined,
				);
			const localStep = plan.steps.find(
				(step): step is Extract<AiFallbackPlanStep, { _tag: "local-model" }> =>
					step._tag === "local-model",
			);
			return Effect.logWarning({
				event: "generate_pr_content",
				status: "rate_limit_fallback_strategy_start",
				provider,
				model,
				strategy,
				github_fallback_chain: plan.githubFallbackChain.join(", "),
				...(localStep !== undefined
					? {
							fallback_provider: "local",
							fallback_model: localStep.model,
							fallback_url: fallbackUrl,
						}
					: {}),
			}).pipe(
				Effect.flatMap(() =>
					executeAiFallbackPlan({
						plan,
						runAttempt,
						filtered,
						localFallbackLayerForModel,
					}),
				),
				Effect.catchIf(isTransientAiError, () => buildCommitFallbackEffect(filtered)),
			);
		}),
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
	/** Optional policy for handling GitHub-models rate limits. */
	aiFallbackStrategy?: RateLimitFallbackStrategyName;
	/** Optional fetch override for tests (also used by rate-limit local fallback). */
	fetch?: typeof fetch;
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
				params.routingContext,
			);
			const delay = retryDelay ?? DEFAULT_RETRY_DELAY;
			const result = yield* generateTitleAndDescriptionWithToolkit(
				prompt,
				filtered,
				delay,
				params.provider,
				params.model,
				{
					...(params.fetch !== undefined ? { fetch: params.fetch } : {}),
					fallbackStrategy: {
						...(params.aiFallbackStrategy !== undefined
							? { aiFallbackStrategy: params.aiFallbackStrategy }
							: {}),
					},
				},
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
	aiFallbackStrategy?: RateLimitFallbackStrategyName;
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
		...(config.aiFallbackStrategy !== undefined
			? { aiFallbackStrategy: config.aiFallbackStrategy }
			: {}),
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
	readonly aiFallbackStrategy?: RateLimitFallbackStrategyName;
	readonly routingContext?: string;
	/** Current PR title override for prompt continuity. */
	readonly existingPrTitle?: string;
	/** Delay between AI retry attempts. Use `Duration.zero` in tests. Default 3s. */
	readonly retryDelay?: Duration.Duration;
	/** Optional fetch override for tests (also used by rate-limit local fallback). */
	readonly fetch?: typeof fetch;
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
			aiFallbackStrategy,
			routingContext,
			retryDelay,
			fetch,
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
			...(aiFallbackStrategy !== undefined ? { aiFallbackStrategy } : {}),
			...(fetch !== undefined ? { fetch } : {}),
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
