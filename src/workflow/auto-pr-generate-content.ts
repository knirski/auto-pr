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
  TemplateRenderError,
  UnexpectedError,
  unknownToMessage,
} from "#auto-pr";
import {
  GithubModelsCatalogRepository,
  makeGithubModelsCatalogRepositoryLive,
} from "#auto-pr/live/github-models-catalog-repository.js";
import { PullRequestClient } from "#auto-pr/live/pull-request-client.js";
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
import {
  buildGithubModelAttemptPlan,
  classifyGithubModelFailure,
  decideGithubModelFallback,
  type GithubModelFailureKind,
} from "#core/github-model-fallback-policy.js";
import type { RoutingContextArtifact } from "#core/routing-artifacts.js";
import { resolveAiToolRoundtripDiffCharBudget } from "#core/sanitize-diff.js";
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

function renderRoutingContextForPrompt(
  routingContext: RoutingContextArtifact | undefined,
): string | undefined {
  if (routingContext === undefined) return undefined;
  return JSON.stringify(routingContext, null, 2);
}

type AiIterationLimits = {
  readonly toolRoundLimit: number;
  readonly tokenBudget: number;
};

type AiLimitSource = "explicit_override" | "routing_decision";

function fallbackDelayForFailure(failure: GithubModelFailureKind): Duration.Duration {
  switch (failure._tag) {
    case "RateLimited":
      return Duration.seconds(2);
    case "Transient":
      return Duration.millis(500);
    default:
      return Duration.zero;
  }
}

function shouldRetryAttemptError(provider: AiProvider, error: unknown): boolean {
  if (error instanceof DescriptionParseError) return true;
  if (provider === "github-models") {
    const failure = classifyGithubModelFailure(error);
    return failure._tag !== "AuthOrConfig" && failure._tag !== "CapabilityMismatch";
  }
  return isTransientAiError(error);
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
    Schedule.addDelay(() => Effect.succeed(delay)),
    Schedule.tap(() =>
      Effect.logWarning({
        event: "generate_pr_content",
        status: "ai_retry",
        message: `Title invalid or AI failed, retrying in about ${delayLabel}...`,
      }),
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
  allowToolCalls: boolean,
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
        ...(allowToolCalls ? {} : { toolChoice: "none" }),
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
  retryDelay: Duration.Duration,
  provider: AiProvider,
  model: string,
  limits: AiIterationLimits,
  allowToolCalls: boolean,
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
    return yield* generateAssistantTextWithToolkit(prompt, provider, model, limits, allowToolCalls);
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
    Effect.retry({
      schedule: makeRetrySchedule(retryDelay),
      while: (error) => shouldRetryAttemptError(provider, error),
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
  routingContext?: RoutingContextArtifact;
  provider: AiProvider;
  model: string;
  retryDelay?: Duration.Duration;
  /** Optional override for max model/tool interaction rounds in a single AI attempt. */
  aiToolRoundLimit?: number;
  /** Optional override for token budget in a single AI attempt. */
  aiTokenBudget?: number;
  /** Optional override for per-tool diff roundtrip char budget in a single AI attempt. */
  aiToolResponseCharBudget?: number;
  /** Source label for routed AI limits vs ad hoc overrides. */
  aiLimitsSource?: AiLimitSource;
  /** Current PR title when updating an open PR (multi-commit AI path only). */
  existingPrTitle?: string;
  /** Whether AI attempt should include diff tools. */
  allowToolCalls?: boolean;
  /** When true, transient AI failures degrade to commit-derived fallback content. */
  allowCommitFallbackOnTransient?: boolean;
  /** When true, skip AI generation and render commit-derived fallback content directly. */
  forcePrimitiveFallback?: boolean;
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
      if (params.forcePrimitiveFallback === true) {
        const fallback = getFallbackTitleAndDescription(filtered);
        title = fallback.title;
        descriptionOverride = fallback.description;
        const bodyResult = renderBodyCore(
          filtered,
          files,
          templateContent,
          descriptionOverride,
          title,
        );
        const body = yield* Effect.fromResult(bodyResult);
        return { title, body, count };
      }
      const commitContent = getDescriptionPromptText(filtered);
      const prompt = buildDescriptionPrompt(
        descriptionPromptText,
        commitContent,
        diffStatOutput,
        params.existingPrTitle,
        renderRoutingContextForPrompt(params.routingContext),
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
      yield* Effect.log({
        event: "generate_pr_content",
        step: "limits",
        status: "computed",
        provider: params.provider,
        model: params.model,
        commit_count: count,
        changed_file_count: files.length,
        prompt_chars: prompt.length,
        token_budget: limits.tokenBudget,
        tool_round_limit: limits.toolRoundLimit,
        token_budget_source:
          params.aiTokenBudget !== undefined
            ? (params.aiLimitsSource ?? "explicit_override")
            : "computed",
        tool_round_limit_source:
          params.aiToolRoundLimit !== undefined
            ? (params.aiLimitsSource ?? "explicit_override")
            : "computed",
      });
      const delay = retryDelay ?? DEFAULT_RETRY_DELAY;
      const result = yield* generateTitleAndDescriptionWithToolkit(
        prompt,
        delay,
        params.provider,
        params.model,
        limits,
        params.allowToolCalls ?? true,
      ).pipe(
        Effect.catchIf(
          (error) => params.allowCommitFallbackOnTransient !== false && isTransientAiError(error),
          () =>
            Effect.succeed(getFallbackTitleAndDescription(filtered)).pipe(
              Effect.tap((fallback) =>
                Effect.logWarning({
                  event: "generate_pr_content",
                  status: "fallback",
                  step: "ai_query",
                  message: "Using commit-derived fallback content after retries",
                  provider: params.provider,
                  model: params.model,
                  title_chars: fallback.title.length,
                  description_chars: fallback.description.length,
                }),
              ),
            ),
        ),
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
                    `AI provider authentication/config error [${e.reason._tag}]: ${e.message}. ${
                      params.provider === "github-models"
                        ? "Check GH_TOKEN and GitHub Models access."
                        : "Check AUTO_PR_AI_OPENAI_COMPAT_URL and credentials."
                    }`,
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
  routingContext?: RoutingContextArtifact;
  aiToolRoundLimit?: number;
  aiTokenBudget?: number;
  aiToolResponseCharBudget?: number;
  aiLimitsSource?: AiLimitSource;
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
      requiresToolCalls?: boolean;
      localFallback?: {
        readonly openaiCompatUrl: string;
        readonly model: string;
        readonly openaiCompatApiKey?: Redacted.Redacted<string>;
      };
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
    ...(config.aiToolRoundLimit !== undefined ? { aiToolRoundLimit: config.aiToolRoundLimit } : {}),
    ...(config.aiTokenBudget !== undefined ? { aiTokenBudget: config.aiTokenBudget } : {}),
    ...(config.aiToolResponseCharBudget !== undefined
      ? { aiToolResponseCharBudget: config.aiToolResponseCharBudget }
      : {}),
    ...(config.aiTokenBudget !== undefined ||
    config.aiToolRoundLimit !== undefined ||
    config.aiToolResponseCharBudget !== undefined
      ? { aiLimitsSource: "routing_decision" as const }
      : {}),
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
        ...(githubModels.requiresToolCalls !== undefined
          ? { requiresToolCalls: githubModels.requiresToolCalls }
          : {}),
        ...(githubModels.aiToolRoundLimit !== undefined
          ? { aiToolRoundLimit: githubModels.aiToolRoundLimit }
          : {}),
        ...(githubModels.aiTokenBudget !== undefined
          ? { aiTokenBudget: githubModels.aiTokenBudget }
          : {}),
        ...(githubModels.aiToolResponseCharBudget !== undefined
          ? { aiToolResponseCharBudget: githubModels.aiToolResponseCharBudget }
          : {}),
        ...(githubModels.localFallback !== undefined
          ? { localFallback: githubModels.localFallback }
          : {}),
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
  const gitLayer = GitContextLive(config.workspace).pipe(Layer.provide(ChildProcessSpawnerLayer));
  const prClientLayer = PullRequestClient.Live(config.workspace, {
    ...(config.provider === "github-models" ? { ghToken: Redacted.value(config.ghToken) } : {}),
    ...(config.githubApiUrl !== undefined ? { githubApiUrl: config.githubApiUrl } : {}),
    ...(config.ghHost !== undefined ? { ghHost: config.ghHost } : {}),
  }).pipe(Layer.provide(ChildProcessSpawnerLayer));

  type ProviderKind = "github-models" | "local-llm";
  type AttemptCandidate = {
    readonly provider: ProviderKind;
    readonly model: string;
    readonly allowToolCalls: boolean;
    readonly selectionMode: string;
    readonly attemptIndex: number;
    readonly openaiCompatUrl?: string;
    readonly openaiCompatApiKey?: Redacted.Redacted<string>;
  };
  type ExecutionState =
    | {
        readonly _tag: "Running";
        readonly queue: readonly AttemptCandidate[];
        readonly lastError?: GeneratePrContentError;
      }
    | { readonly _tag: "PrimitiveFallback"; readonly lastError?: GeneratePrContentError }
    | { readonly _tag: "Completed" };

  const resolveAttemptToolResponseCharBudget = (attempt: AttemptCandidate): number | undefined => {
    const derivedBudget = resolveAiToolRoundtripDiffCharBudget(
      attempt.provider === "github-models" ? "github-models" : "local",
      attempt.model,
    );
    if (attempt.provider !== "github-models") return derivedBudget;
    if (config.aiToolResponseCharBudget === undefined) return derivedBudget;
    if (attempt.model === config.model) return config.aiToolResponseCharBudget;
    return Math.min(config.aiToolResponseCharBudget, derivedBudget);
  };

  const runAttempt = Effect.fn("runAttempt")(function* (attempt: AttemptCandidate) {
    const toolResponseCharBudget = resolveAttemptToolResponseCharBudget(attempt);
    const sharedAttemptConfig = {
      defaultBranch: config.defaultBranch,
      branch: config.branch,
      workspace: config.workspace,
      templatePath: config.templatePath,
      model: attempt.model,
      ...(config.routingContext !== undefined ? { routingContext: config.routingContext } : {}),
      ...(config.githubApiUrl !== undefined ? { githubApiUrl: config.githubApiUrl } : {}),
      ...(config.ghHost !== undefined ? { ghHost: config.ghHost } : {}),
      ...(config.existingPrTitle !== undefined ? { existingPrTitle: config.existingPrTitle } : {}),
      ...(config.retryDelay !== undefined ? { retryDelay: config.retryDelay } : {}),
      ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
    };
    const attemptConfig: RunGeneratePrContentConfig =
      attempt.provider === "github-models"
        ? {
            ...sharedAttemptConfig,
            provider: "github-models",
            ghToken: config.provider === "github-models" ? config.ghToken : Redacted.make(""),
            ...(config.provider === "github-models" && config.requiresToolCalls !== undefined
              ? { requiresToolCalls: config.requiresToolCalls }
              : {}),
            ...(config.provider === "github-models" && config.aiToolRoundLimit !== undefined
              ? { aiToolRoundLimit: config.aiToolRoundLimit }
              : {}),
            ...(config.provider === "github-models" && config.aiTokenBudget !== undefined
              ? { aiTokenBudget: config.aiTokenBudget }
              : {}),
            ...(toolResponseCharBudget !== undefined
              ? { aiToolResponseCharBudget: toolResponseCharBudget }
              : {}),
            ...(config.provider === "github-models" && config.aiLimitsSource !== undefined
              ? { aiLimitsSource: config.aiLimitsSource }
              : {}),
            ...(config.provider === "github-models" && config.localFallback !== undefined
              ? { localFallback: config.localFallback }
              : {}),
          }
        : {
            ...sharedAttemptConfig,
            provider: "local",
            ...(config.provider === "local"
              ? {
                  ...(config.aiToolRoundLimit !== undefined
                    ? { aiToolRoundLimit: config.aiToolRoundLimit }
                    : {}),
                  ...(config.aiTokenBudget !== undefined
                    ? { aiTokenBudget: config.aiTokenBudget }
                    : {}),
                  ...(config.aiToolResponseCharBudget !== undefined
                    ? { aiToolResponseCharBudget: config.aiToolResponseCharBudget }
                    : {}),
                  ...(config.aiLimitsSource !== undefined
                    ? { aiLimitsSource: config.aiLimitsSource }
                    : {}),
                }
              : {}),
            ...(attempt.openaiCompatUrl !== undefined
              ? { openaiCompatUrl: attempt.openaiCompatUrl }
              : {}),
            ...(attempt.openaiCompatApiKey !== undefined
              ? { openaiCompatApiKey: attempt.openaiCompatApiKey }
              : {}),
          };
    const aiLayer = aiProviderLayerFromConfig(
      buildAiProviderConfig(attemptConfig),
      config.fetch !== undefined ? { fetch: config.fetch } : undefined,
    );
    const toolkitLayer = makeDiffToolkitLayer(
      baseRef,
      config.branch,
      toolResponseCharBudget !== undefined ? { toolResponseCharBudget } : undefined,
    ).pipe(Layer.provide(gitLayer));
    const liveLayer = Layer.mergeAll(
      AutoPrPlatformLayer,
      aiLayer,
      gitLayer,
      toolkitLayer,
      prClientLayer,
    );
    return yield* runGeneratePrContentWithServices({
      ...attemptConfig,
      allowToolCalls: attempt.allowToolCalls,
      allowCommitFallbackOnTransient: false,
    }).pipe(
      Effect.annotateLogs({
        attempt_index: String(attempt.attemptIndex),
        model: attempt.model,
        selection_mode: attempt.selectionMode,
      }),
      Effect.tap(() =>
        Effect.log({
          event: "generate_pr_content",
          step: "attempt",
          status: "succeeded",
          attempt_index: attempt.attemptIndex,
          provider: attempt.provider,
          model: attempt.model,
          allows_tool_calls: attempt.allowToolCalls,
          selection_mode: attempt.selectionMode,
          tool_response_char_budget: toolResponseCharBudget,
        }),
      ),
      Effect.tapError((error) =>
        Effect.logWarning({
          event: "generate_pr_content",
          step: "attempt",
          status: "failed",
          attempt_index: attempt.attemptIndex,
          provider: attempt.provider,
          model: attempt.model,
          allows_tool_calls: attempt.allowToolCalls,
          selection_mode: attempt.selectionMode,
          error_kind: classifyGithubModelFailure(error),
          reason: formatError(error),
        }),
      ),
      Effect.provide(liveLayer),
    );
  });

  return Effect.gen(function* () {
    const githubModelsCatalogRepository = yield* GithubModelsCatalogRepository;
    yield* Effect.log({
      event: "generate_pr_content",
      step: "routing",
      status: "resolved",
      provider: config.provider,
      model: config.model,
      routing_context_chars: renderRoutingContextForPrompt(config.routingContext)?.length ?? 0,
      routing_context_present: config.routingContext !== undefined,
    });
    const initialQueue: AttemptCandidate[] =
      config.provider === "local"
        ? [
            {
              provider: "local-llm",
              model: config.model,
              allowToolCalls: true,
              selectionMode: "preferred",
              attemptIndex: 1,
              ...(config.openaiCompatUrl !== undefined
                ? { openaiCompatUrl: config.openaiCompatUrl }
                : {}),
              ...(config.openaiCompatApiKey !== undefined
                ? { openaiCompatApiKey: config.openaiCompatApiKey }
                : {}),
            },
            {
              provider: "local-llm",
              model: config.model,
              allowToolCalls: false,
              selectionMode: "local-no-tool-fallback",
              attemptIndex: 2,
              ...(config.openaiCompatUrl !== undefined
                ? { openaiCompatUrl: config.openaiCompatUrl }
                : {}),
              ...(config.openaiCompatApiKey !== undefined
                ? { openaiCompatApiKey: config.openaiCompatApiKey }
                : {}),
            },
          ]
        : (() => {
            const requiresToolCalls = config.requiresToolCalls ?? true;
            const baseAttempts = buildGithubModelAttemptPlan({
              selectedModel: config.model,
              requiresToolCalls,
              entries: [],
            });
            return baseAttempts.map((attempt, index) => ({
              provider: "github-models" as const,
              model: attempt.model,
              allowToolCalls: attempt.requiresToolCalls,
              selectionMode: attempt.selectionMode,
              attemptIndex: index + 1,
            }));
          })();

    const queue =
      config.provider === "github-models"
        ? yield* Effect.gen(function* () {
            const catalogEntries = yield* githubModelsCatalogRepository.fetchCatalog(
              config.ghToken,
            );
            const requiresToolCalls = config.requiresToolCalls ?? true;
            const githubAttempts = buildGithubModelAttemptPlan({
              selectedModel: config.model,
              requiresToolCalls,
              entries: catalogEntries,
            }).map((attempt, index) => ({
              provider: "github-models" as const,
              model: attempt.model,
              allowToolCalls: attempt.requiresToolCalls,
              selectionMode: attempt.selectionMode,
              attemptIndex: index + 1,
            }));
            const localFallbackAttempts =
              config.localFallback === undefined
                ? []
                : ([
                    {
                      provider: "local-llm" as const,
                      model: config.localFallback.model,
                      allowToolCalls: true,
                      selectionMode: "local-fallback",
                      attemptIndex: githubAttempts.length + 1,
                      openaiCompatUrl: config.localFallback.openaiCompatUrl,
                      ...(config.localFallback.openaiCompatApiKey !== undefined
                        ? { openaiCompatApiKey: config.localFallback.openaiCompatApiKey }
                        : {}),
                    },
                    {
                      provider: "local-llm" as const,
                      model: config.localFallback.model,
                      allowToolCalls: false,
                      selectionMode: "local-no-tool-fallback",
                      attemptIndex: githubAttempts.length + 2,
                      openaiCompatUrl: config.localFallback.openaiCompatUrl,
                      ...(config.localFallback.openaiCompatApiKey !== undefined
                        ? { openaiCompatApiKey: config.localFallback.openaiCompatApiKey }
                        : {}),
                    },
                  ] as const);
            return [...githubAttempts, ...localFallbackAttempts];
          })
        : initialQueue;

    yield* Effect.log({
      event: "generate_pr_content",
      step: "attempt_plan",
      status: "computed",
      attempt_count: queue.length,
      attempts: queue.map((attempt) => ({
        provider: attempt.provider,
        model: attempt.model,
        requires_tool_calls: attempt.allowToolCalls,
        selection_mode: attempt.selectionMode,
      })),
    });

    let state: ExecutionState = { _tag: "Running", queue };
    while (true) {
      switch (state._tag) {
        case "Completed":
          return;
        case "PrimitiveFallback": {
          yield* Effect.logWarning({
            event: "generate_pr_content",
            step: "attempt_plan",
            status: "all_attempts_failed_using_primitive_fallback",
            ...(state.lastError === undefined ? {} : { last_error: formatError(state.lastError) }),
          });
          yield* runGeneratePrContentWithServices({
            ...config,
            model: config.model,
            allowToolCalls: false,
            allowCommitFallbackOnTransient: true,
            forcePrimitiveFallback: true,
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                AutoPrPlatformLayer,
                aiProviderLayerFromConfig(
                  buildAiProviderConfig(config),
                  config.fetch !== undefined ? { fetch: config.fetch } : undefined,
                ),
                gitLayer,
                makeDiffToolkitLayer(baseRef, config.branch, {
                  toolResponseCharBudget: resolveAiToolRoundtripDiffCharBudget(
                    config.provider,
                    config.model,
                  ),
                }).pipe(Layer.provide(gitLayer)),
                prClientLayer,
              ),
            ),
          );
          state = { _tag: "Completed" };
          continue;
        }
        case "Running": {
          const attempt: AttemptCandidate | undefined = state.queue[0];
          const rest = state.queue.slice(1);
          if (attempt === undefined) {
            state = {
              _tag: "PrimitiveFallback",
              ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
            };
            continue;
          }
          const result: Exit.Exit<void, GeneratePrContentError> = yield* runAttempt(attempt).pipe(
            Effect.exit,
          );
          if (Exit.isSuccess(result)) {
            state = { _tag: "Completed" };
            continue;
          }
          const nextError: GeneratePrContentError = Result.match(Cause.findError(result.cause), {
            onSuccess: (error) => normalizeUnknownToGeneratePrContentError(error),
            onFailure: () =>
              new UnexpectedError({
                cause: "attempt failed without a recoverable typed error",
              }),
          });
          const failure = classifyGithubModelFailure(nextError);
          const decision = decideGithubModelFallback({
            failure,
            hasRemainingAttempts: rest.length > 0,
          });
          if (failure._tag === "AuthOrConfig") {
            return yield* Effect.fail(nextError);
          }
          yield* Effect.sleep(fallbackDelayForFailure(failure));
          state =
            decision === "final_fallback"
              ? { _tag: "PrimitiveFallback", lastError: nextError }
              : { _tag: "Running", queue: rest, lastError: nextError };
        }
      }
    }
  }).pipe(
    Effect.provide(
      makeGithubModelsCatalogRepositoryLive(
        config.fetch === undefined ? {} : { fetchImpl: config.fetch },
      ),
    ),
  );
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
  readonly routingContext?: RoutingContextArtifact;
  readonly aiToolRoundLimit?: number;
  readonly aiTokenBudget?: number;
  readonly aiToolResponseCharBudget?: number;
  readonly aiLimitsSource?: AiLimitSource;
  /** Current PR title override for prompt continuity. */
  readonly existingPrTitle?: string;
  /** Delay between AI retry attempts. Use `Duration.zero` in tests. Default 3s. */
  readonly retryDelay?: Duration.Duration;
  readonly allowToolCalls?: boolean;
  readonly allowCommitFallbackOnTransient?: boolean;
  readonly forcePrimitiveFallback?: boolean;
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
      aiToolRoundLimit,
      aiTokenBudget,
      aiToolResponseCharBudget,
      aiLimitsSource,
      retryDelay,
      existingPrTitle: configuredExistingPrTitle,
      allowToolCalls,
      allowCommitFallbackOnTransient,
      forcePrimitiveFallback,
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
      ...(aiToolRoundLimit !== undefined ? { aiToolRoundLimit } : {}),
      ...(aiTokenBudget !== undefined ? { aiTokenBudget } : {}),
      ...(aiToolResponseCharBudget !== undefined ? { aiToolResponseCharBudget } : {}),
      ...(aiLimitsSource !== undefined ? { aiLimitsSource } : {}),
      ...(retryDelay !== undefined && { retryDelay }),
      ...(existingPrTitle !== undefined && { existingPrTitle }),
      ...(allowToolCalls !== undefined ? { allowToolCalls } : {}),
      ...(allowCommitFallbackOnTransient !== undefined ? { allowCommitFallbackOnTransient } : {}),
      ...(forcePrimitiveFallback !== undefined ? { forcePrimitiveFallback } : {}),
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
