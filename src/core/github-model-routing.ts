import type { ModelBandSignals, ReasoningNeed, ToolStrategy } from "./model-routing.js";

export type GithubModelsPlanClass =
	| "copilot-free"
	| "copilot-pro"
	| "copilot-business"
	| "copilot-enterprise"
	| "paid-usage"
	| "unknown";

export type GithubModelsRateLimitTier =
	| "low"
	| "high"
	| "embedding"
	| "azure-openai-o1-preview"
	| "azure-openai-o1-o3-gpt5"
	| "azure-openai-mini"
	| "deepseek-r1"
	| "xai-grok-3"
	| "xai-grok-3-mini"
	| "unknown";

export type GithubModelCatalogEntry = {
	readonly id: string;
	readonly name: string;
	readonly capabilities: readonly string[];
	readonly supportedInputModalities: readonly string[];
	readonly supportedOutputModalities: readonly string[];
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
	readonly rateLimitTier: GithubModelsRateLimitTier;
};

export type GithubModelsRequestEnvelope = {
	readonly model: string;
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
	readonly requestedInputTokens: number;
	readonly requestedOutputTokens: number;
	readonly tokenBudget: number;
	readonly toolRoundLimit: number;
	readonly toolResponseCharBudget: number;
	readonly rateLimitTier: GithubModelsRateLimitTier;
	readonly planClass: GithubModelsPlanClass;
	readonly source: "catalog-and-plan" | "catalog-only" | "static-fallback" | "explicit-model";
};

export type GithubModelsFreeLimit = {
	readonly requestsPerMinute: number | "not-applicable";
	readonly requestsPerDay: number | "not-applicable";
	readonly inputTokensPerRequest: number | "not-applicable";
	readonly outputTokensPerRequest: number | "not-applicable";
	readonly concurrentRequests: number | "not-applicable";
};

export type RequestedEnvelopeInput = {
	readonly promptChars: number;
	readonly commitCount: number;
	readonly changedFileCount: number;
	readonly sourceChurn: number;
	readonly toolStrategy: ToolStrategy;
	readonly reasoningNeed: ReasoningNeed;
};

const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;
const MIN_TOOL_ROUNDS = 2;
const MAX_TOOL_ROUNDS = 12;
const MIN_TOKEN_BUDGET = 4_000;
const MAX_TOKEN_BUDGET = 40_000;
const DEFAULT_TOKEN_BUDGET = 12_000;
const DEFAULT_OUTPUT_RESERVE = 1_500;
const HARD_TOOL_RESPONSE_CHAR_CEILING = 32_000;
const MIN_TOOL_RESPONSE_CHARS = 1_500;

type TierLimitTable = Record<GithubModelsRateLimitTier, GithubModelsFreeLimit>;

// Mirrors docs categories with conservative values for generation safety.
const FREE_LIMITS: TierLimitTable = {
	low: {
		requestsPerMinute: 10,
		requestsPerDay: "not-applicable",
		inputTokensPerRequest: 16_000,
		outputTokensPerRequest: 4_000,
		concurrentRequests: 1,
	},
	high: {
		requestsPerMinute: 5,
		requestsPerDay: "not-applicable",
		inputTokensPerRequest: 8_000,
		outputTokensPerRequest: 2_000,
		concurrentRequests: 1,
	},
	embedding: {
		requestsPerMinute: 10,
		requestsPerDay: "not-applicable",
		inputTokensPerRequest: "not-applicable",
		outputTokensPerRequest: "not-applicable",
		concurrentRequests: 1,
	},
	"azure-openai-o1-preview": {
		requestsPerMinute: 2,
		requestsPerDay: "not-applicable",
		inputTokensPerRequest: 8_000,
		outputTokensPerRequest: 2_000,
		concurrentRequests: 1,
	},
	"azure-openai-o1-o3-gpt5": {
		requestsPerMinute: 2,
		requestsPerDay: "not-applicable",
		inputTokensPerRequest: 8_000,
		outputTokensPerRequest: 2_000,
		concurrentRequests: 1,
	},
	"azure-openai-mini": {
		requestsPerMinute: 5,
		requestsPerDay: "not-applicable",
		inputTokensPerRequest: 8_000,
		outputTokensPerRequest: 2_000,
		concurrentRequests: 1,
	},
	"deepseek-r1": {
		requestsPerMinute: 2,
		requestsPerDay: "not-applicable",
		inputTokensPerRequest: 8_000,
		outputTokensPerRequest: 2_000,
		concurrentRequests: 1,
	},
	"xai-grok-3": {
		requestsPerMinute: 2,
		requestsPerDay: "not-applicable",
		inputTokensPerRequest: 8_000,
		outputTokensPerRequest: 2_000,
		concurrentRequests: 1,
	},
	"xai-grok-3-mini": {
		requestsPerMinute: 5,
		requestsPerDay: "not-applicable",
		inputTokensPerRequest: 8_000,
		outputTokensPerRequest: 2_000,
		concurrentRequests: 1,
	},
	unknown: {
		requestsPerMinute: 5,
		requestsPerDay: "not-applicable",
		inputTokensPerRequest: 8_000,
		outputTokensPerRequest: 2_000,
		concurrentRequests: 1,
	},
};

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function estimateTokensFromChars(chars: number): number {
	return Math.max(1, Math.ceil(chars / TOKEN_ESTIMATE_CHARS_PER_TOKEN));
}

function toolStrategyComplexityBoost(toolStrategy: ToolStrategy): number {
	if (toolStrategy === "none") return 0;
	if (toolStrategy === "hotspot") return 1;
	if (toolStrategy === "commit-diff") return 2;
	return 3;
}

function reasoningBoost(reasoningNeed: ReasoningNeed): number {
	if (reasoningNeed === "low") return 0;
	if (reasoningNeed === "medium") return 1;
	return 2;
}

function computeRequestedEnvelope(input: RequestedEnvelopeInput) {
	const complexityBoost =
		Math.floor(Math.max(0, input.commitCount - 2) / 4) +
		Math.floor(input.changedFileCount / 15) +
		Math.floor(input.sourceChurn / 1_200) +
		toolStrategyComplexityBoost(input.toolStrategy) +
		reasoningBoost(input.reasoningNeed);
	const requestedInput = clamp(
		DEFAULT_TOKEN_BUDGET + estimateTokensFromChars(input.promptChars) + complexityBoost * 1_000,
		MIN_TOKEN_BUDGET,
		MAX_TOKEN_BUDGET,
	);
	const requestedOutput = clamp(DEFAULT_OUTPUT_RESERVE + complexityBoost * 250, 1_000, 4_000);
	const toolRoundLimit = clamp(6 + complexityBoost, MIN_TOOL_ROUNDS, MAX_TOOL_ROUNDS);
	return {
		requestedInputTokens: Math.floor(requestedInput),
		requestedOutputTokens: Math.floor(requestedOutput),
		toolRoundLimit,
	};
}

function normalizePlanClass(planClass: GithubModelsPlanClass): GithubModelsPlanClass {
	return planClass === "unknown" ? "copilot-free" : planClass;
}

function resolveFreeLimit(tier: GithubModelsRateLimitTier): GithubModelsFreeLimit {
	return FREE_LIMITS[tier] ?? FREE_LIMITS.unknown;
}

function tokenLimitOrInfinity(value: number | "not-applicable"): number {
	return value === "not-applicable" ? Number.POSITIVE_INFINITY : value;
}

function deriveToolResponseCharBudget(input: {
	readonly inputTokenBudget: number;
	readonly outputTokenBudget: number;
	readonly toolRoundLimit: number;
}): number {
	// Reserve input for system/prompt history and output for the final JSON payload.
	const roundReserve = Math.max(1_000, Math.floor(input.inputTokenBudget * 0.35));
	const availableInput = Math.max(
		0,
		input.inputTokenBudget - roundReserve - input.outputTokenBudget,
	);
	const perRoundTokens = Math.floor(availableInput / Math.max(1, input.toolRoundLimit));
	const chars = perRoundTokens * TOKEN_ESTIMATE_CHARS_PER_TOKEN;
	return clamp(chars, MIN_TOOL_RESPONSE_CHARS, HARD_TOOL_RESPONSE_CHAR_CEILING);
}

function isTextCapable(entry: GithubModelCatalogEntry): boolean {
	return entry.supportedOutputModalities.some((m) => m.toLowerCase() === "text");
}

function hasToolCapability(entry: GithubModelCatalogEntry): boolean {
	return entry.capabilities.some((c) => c.toLowerCase() === "tool-calling");
}

export function buildGithubModelsRequestEnvelope(input: {
	readonly model: string;
	readonly explicitModel: boolean;
	readonly requiresToolCalls: boolean;
	readonly planClass: GithubModelsPlanClass;
	readonly requested: RequestedEnvelopeInput;
	readonly catalogEntry?: GithubModelCatalogEntry;
}): GithubModelsRequestEnvelope {
	const requested = computeRequestedEnvelope(input.requested);
	const catalog = input.catalogEntry;
	const source: GithubModelsRequestEnvelope["source"] =
		catalog === undefined
			? input.explicitModel
				? "explicit-model"
				: "static-fallback"
			: input.planClass === "unknown"
				? "catalog-only"
				: "catalog-and-plan";
	const rateLimitTier = catalog?.rateLimitTier ?? "unknown";
	const catalogInputTokens = catalog?.maxInputTokens ?? 8_000;
	const catalogOutputTokens = catalog?.maxOutputTokens ?? 2_000;
	const effectivePlan = normalizePlanClass(input.planClass);
	const freeLimits = resolveFreeLimit(rateLimitTier);
	const allowedInputByPlan =
		effectivePlan === "paid-usage"
			? catalogInputTokens
			: Math.min(catalogInputTokens, tokenLimitOrInfinity(freeLimits.inputTokensPerRequest));
	const allowedOutputByPlan =
		effectivePlan === "paid-usage"
			? catalogOutputTokens
			: Math.min(catalogOutputTokens, tokenLimitOrInfinity(freeLimits.outputTokensPerRequest));
	const maxInputTokens = Math.max(1_000, Math.floor(allowedInputByPlan));
	const maxOutputTokens = Math.max(500, Math.floor(allowedOutputByPlan));
	const requestedInputTokens = requested.requestedInputTokens;
	const requestedOutputTokens = requested.requestedOutputTokens;
	const inputTokenBudget = Math.min(requestedInputTokens, maxInputTokens);
	const outputTokenBudget = Math.min(requestedOutputTokens, maxOutputTokens);
	const toolRoundLimit =
		catalog !== undefined && input.requiresToolCalls && !hasToolCapability(catalog)
			? MIN_TOOL_ROUNDS
			: requested.toolRoundLimit;
	const toolResponseCharBudget = deriveToolResponseCharBudget({
		inputTokenBudget,
		outputTokenBudget,
		toolRoundLimit,
	});
	const tokenBudget = Math.max(
		MIN_TOKEN_BUDGET,
		Math.min(MAX_TOKEN_BUDGET, inputTokenBudget + outputTokenBudget),
	);
	return {
		model: input.model,
		maxInputTokens,
		maxOutputTokens,
		requestedInputTokens,
		requestedOutputTokens,
		tokenBudget,
		toolRoundLimit,
		toolResponseCharBudget,
		rateLimitTier,
		planClass: input.planClass,
		source,
	};
}

export function parseGithubModelsRateLimitTier(
	value: string | undefined,
): GithubModelsRateLimitTier {
	const normalized = (value ?? "").trim().toLowerCase();
	if (normalized === "low") return "low";
	if (normalized === "high") return "high";
	if (normalized === "embedding") return "embedding";
	if (normalized === "azure-openai-o1-preview") return "azure-openai-o1-preview";
	if (normalized === "azure-openai-o1-o3-gpt5") return "azure-openai-o1-o3-gpt5";
	if (normalized === "azure-openai-mini") return "azure-openai-mini";
	if (normalized === "deepseek-r1") return "deepseek-r1";
	if (normalized === "xai-grok-3") return "xai-grok-3";
	if (normalized === "xai-grok-3-mini") return "xai-grok-3-mini";
	return "unknown";
}

export function parseGithubModelsPlanClass(value: string | undefined): GithubModelsPlanClass {
	const normalized = (value ?? "").trim().toLowerCase();
	if (normalized === "copilot-free") return "copilot-free";
	if (normalized === "copilot-pro") return "copilot-pro";
	if (normalized === "copilot-business") return "copilot-business";
	if (normalized === "copilot-enterprise") return "copilot-enterprise";
	if (normalized === "paid-usage") return "paid-usage";
	return "unknown";
}

export function pickGithubModelCatalogEntry(input: {
	readonly selectedModel: string;
	readonly entries: readonly GithubModelCatalogEntry[];
	readonly requiresToolCalls: boolean;
}): GithubModelCatalogEntry | undefined {
	const selected = input.entries.find((entry) => entry.id === input.selectedModel);
	if (selected !== undefined && isTextCapable(selected)) {
		if (!input.requiresToolCalls || hasToolCapability(selected)) return selected;
	}
	// Keep selection deterministic; fallback to the first text-capable candidate.
	return input.entries.find((entry) => {
		if (!isTextCapable(entry)) return false;
		return !input.requiresToolCalls || hasToolCapability(entry);
	});
}

export function toModelBandRequestedEnvelopeInput(input: {
	readonly signals: ModelBandSignals;
	readonly promptCharsEstimate: number;
	readonly toolStrategy: ToolStrategy;
	readonly reasoningNeed: ReasoningNeed;
}): RequestedEnvelopeInput {
	return {
		promptChars: input.promptCharsEstimate,
		commitCount: input.signals.semanticCommitCount,
		changedFileCount: input.signals.changedFileCount,
		sourceChurn: input.signals.sourceChurn,
		toolStrategy: input.toolStrategy,
		reasoningNeed: input.reasoningNeed,
	};
}
