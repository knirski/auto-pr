/**
 * Pure OpenRouter model-catalog policy: wire parsing, free-model feasibility,
 * route-class selection, and the provider-neutral cloud request envelope.
 *
 * The live OpenRouter repository performs HTTP; everything here is synchronous
 * and side-effect free so selection policy stays easy to test.
 */

import { Match, Predicate, Result } from "effect";
import type { ModelBand, ReasoningNeed, ToolStrategy } from "./model-routing.js";

export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-oss-20b:free";
export const DEFAULT_OPENROUTER_TITLE = "auto-pr";

const OPENROUTER_FREE_ROUTER_MODEL = "openrouter/free";
const DEFAULT_CONTEXT_LENGTH = 8_000;
const MIN_INPUT_RESERVE = 1_000;
const MIN_OUTPUT_RESERVE = 500;

export type OpenRouterRouteClass =
  | "A-text-light"
  | "B-text-medium"
  | "B-tool-medium"
  | "C-text-strong"
  | "C-tool-strong";

export type OpenRouterModelPricingOverride = {
  readonly conditionKeys: readonly string[];
  readonly prices: Readonly<Record<string, number | undefined>>;
};

export type OpenRouterModelPricing = {
  readonly prompt: number | undefined;
  readonly completion: number | undefined;
  readonly request: number | undefined;
  readonly image: number | undefined;
  readonly imageOutput: number | undefined;
  readonly imageToken: number | undefined;
  readonly audio: number | undefined;
  readonly audioOutput: number | undefined;
  readonly webSearch: number | undefined;
  readonly internalReasoning: number | undefined;
  readonly inputCacheRead: number | undefined;
  readonly inputCacheWrite: number | undefined;
  readonly inputCacheWrite1h: number | undefined;
  readonly overrides: readonly OpenRouterModelPricingOverride[];
  readonly unknownPriceKeys: readonly string[];
};

export type OpenRouterModelCatalogEntry = {
  readonly id: string;
  readonly name: string;
  readonly contextLength: number;
  readonly supportedParameters: readonly string[];
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly expirationDate?: string;
  readonly pricing: OpenRouterModelPricing;
};

export type OpenRouterModelSelection = {
  readonly model: string;
  readonly requiresToolCalls: boolean;
  readonly selectionMode:
    | "configured"
    | "preferred"
    | "catalog"
    | "free-tool-fallback"
    | "free-text-fallback"
    | "static-fallback";
  readonly catalogEntry?: OpenRouterModelCatalogEntry;
};

/**
 * Error payload from {@link validateOpenRouterModelId}. Not a tagged domain
 * error; shell config maps it to AutoPrConfigError.
 */
export interface OpenRouterModelIdError {
  readonly model: string;
  readonly reason: string;
}

export type CloudModelRequestEnvelope = {
  readonly provider: "openrouter";
  readonly model: string;
  readonly contextLength: number;
  readonly requestedInputTokens: number;
  readonly requestedOutputTokens: number;
  readonly tokenBudget: number;
  readonly toolRoundLimit: number;
  readonly toolResponseCharBudget: number;
  readonly source: "catalog" | "configured" | "static-fallback";
};

export const OPENROUTER_FREE_MODEL_PREFERENCES: Record<OpenRouterRouteClass, readonly string[]> = {
  "A-text-light": [
    "openai/gpt-oss-20b:free",
    "google/gemma-4-26b-a4b-it:free",
    "cohere/north-mini-code:free",
  ],
  "B-text-medium": [
    "openai/gpt-oss-20b:free",
    "google/gemma-4-26b-a4b-it:free",
    "cohere/north-mini-code:free",
  ],
  "B-tool-medium": [
    "openai/gpt-oss-20b:free",
    "google/gemma-4-26b-a4b-it:free",
    "cohere/north-mini-code:free",
  ],
  "C-text-strong": [
    "openai/gpt-oss-20b:free",
    "google/gemma-4-26b-a4b-it:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
  ],
  "C-tool-strong": [
    "openai/gpt-oss-20b:free",
    "google/gemma-4-26b-a4b-it:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
  ],
};

type NormalizedPriceKey =
  | "prompt"
  | "completion"
  | "request"
  | "image"
  | "imageOutput"
  | "imageToken"
  | "audio"
  | "audioOutput"
  | "webSearch"
  | "internalReasoning"
  | "inputCacheRead"
  | "inputCacheWrite"
  | "inputCacheWrite1h";

const WIRE_PRICE_KEYS: Readonly<Record<string, NormalizedPriceKey>> = {
  prompt: "prompt",
  completion: "completion",
  request: "request",
  image: "image",
  image_output: "imageOutput",
  image_token: "imageToken",
  audio: "audio",
  audio_output: "audioOutput",
  web_search: "webSearch",
  internal_reasoning: "internalReasoning",
  input_cache_read: "inputCacheRead",
  input_cache_write: "inputCacheWrite",
  input_cache_write_1h: "inputCacheWrite1h",
};

const NORMALIZED_PRICE_KEYS: readonly NormalizedPriceKey[] = [
  "prompt",
  "completion",
  "request",
  "image",
  "imageOutput",
  "imageToken",
  "audio",
  "audioOutput",
  "webSearch",
  "internalReasoning",
  "inputCacheRead",
  "inputCacheWrite",
  "inputCacheWrite1h",
];

// Keep in sync with NORMALIZED_PRICE_KEYS; used to reject unknown override prices.
const KNOWN_NORMALIZED_PRICE_KEYS: ReadonlySet<string> = new Set(NORMALIZED_PRICE_KEYS);

// ─── Pricing ─────────────────────────────────────────────────────────────────

/** Parse an OpenRouter price value; missing or malformed values stay unknown. */
export function parseOpenRouterPrice(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizePricingOverride(raw: unknown): OpenRouterModelPricingOverride | undefined {
  if (!Predicate.isObject(raw)) return undefined;
  const conditionKeys: string[] = [];
  const prices: Record<string, number | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalizedKey = WIRE_PRICE_KEYS[key];
    if (normalizedKey === undefined) {
      conditionKeys.push(key);
      continue;
    }
    prices[normalizedKey] = parseOpenRouterPrice(value);
  }
  return { conditionKeys, prices };
}

function normalizePricingOverrides(raw: unknown): readonly OpenRouterModelPricingOverride[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizePricingOverride)
    .filter((override): override is OpenRouterModelPricingOverride => override !== undefined);
}

/** Normalize the OpenRouter `pricing` object; unknown keys make a model ineligible. */
export function normalizeOpenRouterPricing(rawPricing: unknown): OpenRouterModelPricing {
  const raw = Predicate.isObject(rawPricing) ? rawPricing : {};
  const normalized: Partial<Record<NormalizedPriceKey, number | undefined>> = {};
  const unknownPriceKeys: string[] = [];
  let overrides: readonly OpenRouterModelPricingOverride[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (key === "overrides") {
      overrides = normalizePricingOverrides(value);
      continue;
    }
    const normalizedKey = WIRE_PRICE_KEYS[key];
    if (normalizedKey === undefined) {
      unknownPriceKeys.push(key);
      continue;
    }
    normalized[normalizedKey] = parseOpenRouterPrice(value);
  }
  return {
    prompt: normalized.prompt,
    completion: normalized.completion,
    request: normalized.request,
    image: normalized.image,
    imageOutput: normalized.imageOutput,
    imageToken: normalized.imageToken,
    audio: normalized.audio,
    audioOutput: normalized.audioOutput,
    webSearch: normalized.webSearch,
    internalReasoning: normalized.internalReasoning,
    inputCacheRead: normalized.inputCacheRead,
    inputCacheWrite: normalized.inputCacheWrite,
    inputCacheWrite1h: normalized.inputCacheWrite1h,
    overrides,
    unknownPriceKeys,
  };
}

function hasMalformedPrice(rawPricing: unknown): boolean {
  if (!Predicate.isObject(rawPricing)) return false;
  for (const [key, value] of Object.entries(rawPricing)) {
    if (key === "overrides") continue;
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (parseOpenRouterPrice(value) === undefined) return true;
  }
  return false;
}

function hasMalformedOverrides(rawPricing: unknown): boolean {
  if (!Predicate.isObject(rawPricing)) return false;
  const raw = rawPricing.overrides;
  if (raw === undefined || raw === null) return false;
  if (!Array.isArray(raw)) return true;
  return raw.some((override) => !Predicate.isObject(override));
}

// ─── Catalog parsing ─────────────────────────────────────────────────────────

function parseContextLength(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return DEFAULT_CONTEXT_LENGTH;
}

function parseExpirationDate(value: unknown): string | undefined {
  if (!Predicate.isString(value)) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(Predicate.isString)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function parseCatalogEntry(raw: unknown): OpenRouterModelCatalogEntry | undefined {
  if (!Predicate.isObject(raw)) return undefined;
  const rawId = raw.id;
  const id = Predicate.isString(rawId) ? rawId.trim() : "";
  if (id === "") return undefined;
  const rawPricing = raw.pricing;
  if (hasMalformedPrice(rawPricing) || hasMalformedOverrides(rawPricing)) return undefined;
  const rawName = raw.name;
  const name = Predicate.isString(rawName) && rawName.trim() !== "" ? rawName.trim() : id;
  const rawArchitecture = raw.architecture;
  const architecture = Predicate.isObject(rawArchitecture) ? rawArchitecture : {};
  const expirationDate = parseExpirationDate(raw.expiration_date);
  return {
    id,
    name,
    contextLength: parseContextLength(raw.context_length),
    supportedParameters: parseStringArray(raw.supported_parameters),
    inputModalities: parseStringArray(architecture.input_modalities),
    outputModalities: parseStringArray(architecture.output_modalities),
    ...(expirationDate === undefined ? {} : { expirationDate }),
    pricing: normalizeOpenRouterPricing(rawPricing),
  };
}

/**
 * Parse an OpenRouter `/models` response. Accepts `{ data: [...] }` or a direct
 * array (tests); malformed entries are skipped without failing the catalog.
 */
export function parseOpenRouterModelCatalog(raw: unknown): readonly OpenRouterModelCatalogEntry[] {
  const candidates = Array.isArray(raw)
    ? raw
    : Predicate.isObject(raw) && Array.isArray(raw.data)
      ? raw.data
      : [];
  return candidates
    .map(parseCatalogEntry)
    .filter((entry): entry is OpenRouterModelCatalogEntry => entry !== undefined);
}

// ─── Free-model policy ───────────────────────────────────────────────────────

/** Validate a configured OpenRouter model ID; paid routing is out of scope. */
export function validateOpenRouterModelId(
  model: string,
): Result.Result<string, OpenRouterModelIdError> {
  const trimmed = model.trim();
  if (trimmed === "") {
    return Result.fail({ model: trimmed, reason: "OpenRouter model ID must not be empty" });
  }
  if (trimmed.endsWith(":free") || trimmed === OPENROUTER_FREE_ROUTER_MODEL) {
    return Result.succeed(trimmed);
  }
  return Result.fail({
    model: trimmed,
    reason: `Paid OpenRouter model routing is intentionally out of scope; use a ":free" model or "${OPENROUTER_FREE_ROUTER_MODEL}"`,
  });
}

/**
 * Treat an expiration date before the current UTC date as expired. Missing or
 * malformed dates make an entry infeasible; dates expiring today stay feasible.
 */
export function isOpenRouterModelExpired(expirationDate: string | undefined, now?: Date): boolean {
  if (expirationDate === undefined) return false;
  const trimmed = expirationDate.trim();
  if (trimmed === "") return false;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return true;
  const reference = now ?? new Date();
  const todayUtcStart = Date.UTC(
    reference.getUTCFullYear(),
    reference.getUTCMonth(),
    reference.getUTCDate(),
  );
  return parsed < todayUtcStart;
}

function isKnownZeroOrAbsent(value: number | undefined): boolean {
  return value === undefined || value === 0;
}

function isUnconditionallyZeroOverride(override: OpenRouterModelPricingOverride): boolean {
  // Conditional pricing can change per request; only unconditional, all-zero,
  // fully known overrides can be proven free.
  if (override.conditionKeys.length > 0) return false;
  const priceKeys = Object.keys(override.prices);
  if (priceKeys.length === 0) return false;
  return priceKeys.every(
    (key) => KNOWN_NORMALIZED_PRICE_KEYS.has(key) && override.prices[key] === 0,
  );
}

/**
 * True when every chargeable component the model advertises is explicitly zero,
 * no unknown pricing keys are present, and no conditional override can charge.
 *
 * OpenRouter only lists components a model charges for; absent components are
 * not advertised as chargeable, while present ones must be zero.
 */
export function hasOnlyKnownZeroPrices(pricing: OpenRouterModelPricing): boolean {
  if (pricing.unknownPriceKeys.length > 0) return false;
  if (!NORMALIZED_PRICE_KEYS.every((key) => isKnownZeroOrAbsent(pricing[key]))) return false;
  return pricing.overrides.every(isUnconditionallyZeroOverride);
}

/** OpenRouter free-model predicate: `:free` id, live, and known zero prices. */
export function isOpenRouterFreeModel(entry: OpenRouterModelCatalogEntry): boolean {
  return (
    entry.id.endsWith(":free") &&
    !isOpenRouterModelExpired(entry.expirationDate) &&
    hasOnlyKnownZeroPrices(entry.pricing)
  );
}

/** True when the model advertises text output. */
export function modelSupportsTextOutput(entry: OpenRouterModelCatalogEntry): boolean {
  return entry.outputModalities.some((modality) => modality.trim().toLowerCase() === "text");
}

function supportsParameter(entry: OpenRouterModelCatalogEntry, parameter: string): boolean {
  return entry.supportedParameters.some((value) => value.trim().toLowerCase() === parameter);
}

/** True when the model advertises both `tools` and `tool_choice`. */
export function modelSupportsToolCalls(entry: OpenRouterModelCatalogEntry): boolean {
  return supportsParameter(entry, "tools") && supportsParameter(entry, "tool_choice");
}

// ─── Route selection ─────────────────────────────────────────────────────────

/** Map the existing band decision onto an OpenRouter route class. */
export function resolveOpenRouterRouteClass(input: {
  readonly band: ModelBand;
  readonly requiresToolCalls: boolean;
}): OpenRouterRouteClass {
  return Match.value(input).pipe(
    // Band A routes never require tools; keep the light text route for safety.
    Match.when({ band: "A", requiresToolCalls: false }, () => "A-text-light" as const),
    Match.when({ band: "A", requiresToolCalls: true }, () => "A-text-light" as const),
    Match.when({ band: "B", requiresToolCalls: false }, () => "B-text-medium" as const),
    Match.when({ band: "B", requiresToolCalls: true }, () => "B-tool-medium" as const),
    Match.when({ band: "C", requiresToolCalls: false }, () => "C-text-strong" as const),
    Match.when({ band: "C", requiresToolCalls: true }, () => "C-tool-strong" as const),
    Match.exhaustive,
  );
}

function configuredFreeModel(configuredModel: string | undefined): string | undefined {
  if (configuredModel === undefined) return undefined;
  const validated = validateOpenRouterModelId(configuredModel);
  return Result.isSuccess(validated) ? validated.success : undefined;
}

/**
 * Select a feasible free model for the route.
 *
 * Order: catalog-feasible configured model, route-class preference, any free
 * tool model for tool routes, any free text model, then the configured model or
 * the static default when the catalog has nothing usable.
 */
export function pickOpenRouterModelCatalogEntry(input: {
  readonly band: ModelBand;
  readonly configuredModel?: string;
  readonly entries: readonly OpenRouterModelCatalogEntry[];
  readonly requiresToolCalls: boolean;
}): OpenRouterModelSelection {
  const configured = configuredFreeModel(input.configuredModel);
  const routeClass = resolveOpenRouterRouteClass({
    band: input.band,
    requiresToolCalls: input.requiresToolCalls,
  });
  const feasibleText = input.entries.filter(isOpenRouterFreeModel).filter(modelSupportsTextOutput);
  const feasibleTools = feasibleText.filter(modelSupportsToolCalls);
  const routePool = input.requiresToolCalls ? feasibleTools : feasibleText;

  if (configured !== undefined) {
    const configuredEntry = routePool.find((entry) => entry.id === configured);
    if (configuredEntry !== undefined) {
      return {
        model: configuredEntry.id,
        requiresToolCalls: input.requiresToolCalls,
        selectionMode: "preferred",
        catalogEntry: configuredEntry,
      };
    }
  }

  for (const preferred of OPENROUTER_FREE_MODEL_PREFERENCES[routeClass]) {
    const preferredEntry = routePool.find((entry) => entry.id === preferred);
    if (preferredEntry !== undefined) {
      return {
        model: preferredEntry.id,
        requiresToolCalls: input.requiresToolCalls,
        selectionMode: "catalog",
        catalogEntry: preferredEntry,
      };
    }
  }

  const fallbackEntry = routePool[0];
  if (fallbackEntry !== undefined) {
    return {
      model: fallbackEntry.id,
      requiresToolCalls: input.requiresToolCalls,
      selectionMode: input.requiresToolCalls ? "free-tool-fallback" : "free-text-fallback",
      catalogEntry: fallbackEntry,
    };
  }

  if (input.requiresToolCalls) {
    const degradedTextEntry = feasibleText[0];
    if (degradedTextEntry !== undefined) {
      return {
        model: degradedTextEntry.id,
        requiresToolCalls: false,
        selectionMode: "free-text-fallback",
        catalogEntry: degradedTextEntry,
      };
    }
  }

  if (configured !== undefined) {
    return {
      model: configured,
      requiresToolCalls: input.requiresToolCalls,
      selectionMode: "configured",
    };
  }

  return {
    model: DEFAULT_OPENROUTER_MODEL,
    requiresToolCalls: input.requiresToolCalls,
    selectionMode: "static-fallback",
  };
}

// ─── Request envelope ────────────────────────────────────────────────────────

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

function normalizeContextLength(contextLength: number | undefined): number {
  if (contextLength === undefined || !Number.isFinite(contextLength) || contextLength <= 0) {
    return DEFAULT_CONTEXT_LENGTH;
  }
  return Math.max(1, Math.floor(contextLength));
}

/** Build the cloud request envelope, clamping the token budget to context length. */
export function buildOpenRouterRequestEnvelope(input: {
  readonly model: string;
  readonly requested: RequestedEnvelopeInput;
  readonly catalogEntry?: OpenRouterModelCatalogEntry;
  readonly source: CloudModelRequestEnvelope["source"];
}): CloudModelRequestEnvelope {
  const requested = computeRequestedEnvelope(input.requested);
  const contextLength = normalizeContextLength(input.catalogEntry?.contextLength);
  const outputTokenBudget = Math.min(
    requested.requestedOutputTokens,
    Math.max(MIN_OUTPUT_RESERVE, contextLength - MIN_INPUT_RESERVE),
  );
  const inputTokenBudget = Math.min(
    requested.requestedInputTokens,
    Math.max(MIN_INPUT_RESERVE, contextLength - outputTokenBudget),
  );
  return {
    provider: "openrouter",
    model: input.model,
    contextLength,
    requestedInputTokens: requested.requestedInputTokens,
    requestedOutputTokens: requested.requestedOutputTokens,
    tokenBudget: Math.min(inputTokenBudget + outputTokenBudget, MAX_TOKEN_BUDGET),
    toolRoundLimit: requested.toolRoundLimit,
    toolResponseCharBudget: deriveToolResponseCharBudget({
      inputTokenBudget,
      outputTokenBudget,
      toolRoundLimit: requested.toolRoundLimit,
    }),
    source: input.source,
  };
}
