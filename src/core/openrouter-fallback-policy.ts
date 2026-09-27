/**
 * Pure OpenRouter/cloud fallback policy: failure classification, attempt
 * planning, and fallback decisions.
 *
 * OpenRouter documents auth/quota failures as permanent configuration problems
 * (401/402/403) while rate limits and upstream provider availability failures
 * are retryable (408/429/5xx/network). Attempt planning additionally guarantees
 * that a tool-required route never degrades into a tool-less AI request.
 */

import { Predicate } from "effect";
import { AutoPrConfigError } from "./errors.js";
import type { ModelBand } from "./model-routing.js";
import {
  type OpenRouterModelCatalogEntry,
  pickOpenRouterModelCatalogEntry,
} from "./openrouter-routing.js";

export type CloudModelFailureClassification =
  | {
      readonly kind: "permanent";
      readonly reason: "authentication" | "authorization" | "payment-required" | "invalid-request";
    }
  | {
      readonly kind: "retryable";
      readonly reason:
        | "rate-limit"
        | "timeout"
        | "provider-overloaded"
        | "provider-unavailable"
        | "network";
    }
  | { readonly kind: "unknown-retryable"; readonly reason: "unknown" };

export type CloudModelFallbackDecision = "next_attempt" | "final_fallback" | "fail";

export type OpenRouterModelAttempt = {
  readonly provider: "openrouter" | "local";
  readonly model: string;
  readonly requiresToolCalls: boolean;
  readonly selectionMode: string;
};

export type OpenRouterLocalFallback = {
  readonly model: string;
  readonly selectionMode?: string;
};

const UNKNOWN_RETRYABLE: CloudModelFailureClassification = {
  kind: "unknown-retryable",
  reason: "unknown",
};

const RETRYABLE_ERROR_TYPES: Readonly<Record<string, CloudModelFailureClassification>> = {
  rate_limit_exceeded: { kind: "retryable", reason: "rate-limit" },
  provider_overloaded: { kind: "retryable", reason: "provider-overloaded" },
  provider_unavailable: { kind: "retryable", reason: "provider-unavailable" },
};

const PERMANENT_ERROR_TYPES: Readonly<Record<string, CloudModelFailureClassification>> = {
  authentication: { kind: "permanent", reason: "authentication" },
  permission_denied: { kind: "permanent", reason: "authorization" },
  payment_required: { kind: "permanent", reason: "payment-required" },
  insufficient_credits: { kind: "permanent", reason: "payment-required" },
  insufficient_quota: { kind: "permanent", reason: "payment-required" },
  invalid_request: { kind: "permanent", reason: "invalid-request" },
  context_length_exceeded: { kind: "permanent", reason: "invalid-request" },
};

const ERROR_TYPE_KEYS = ["error_type", "errorType"] as const;

// ─── Shape extraction ────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return Predicate.isObject(value) ? (value as Record<string, unknown>) : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  if (record === undefined) return undefined;
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  if (record === undefined) return undefined;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorTypeFromRecord(record: Record<string, unknown> | undefined): string | undefined {
  for (const key of ERROR_TYPE_KEYS) {
    const value = stringField(record, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function errorTypeFromWireBody(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const errorObject = asRecord(asRecord(parsed)?.error);
  return errorTypeFromRecord(asRecord(errorObject?.metadata));
}

function extractErrorType(error: unknown): string | undefined {
  const root = asRecord(error);
  if (root === undefined) return undefined;
  const rootMetadata = asRecord(root.metadata);
  const fromRoot =
    errorTypeFromRecord(rootMetadata) ?? errorTypeFromRecord(asRecord(rootMetadata?.openrouter));
  if (fromRoot !== undefined) return fromRoot;

  const reason = asRecord(root.reason);
  const reasonMetadata = asRecord(reason?.metadata);
  const fromReason =
    errorTypeFromRecord(reasonMetadata) ??
    errorTypeFromRecord(asRecord(reasonMetadata?.openrouter));
  if (fromReason !== undefined) return fromReason;

  const http = asRecord(root.http) ?? asRecord(reason?.http);
  return errorTypeFromWireBody(stringField(http, "body"));
}

function extractHttpStatus(error: unknown): number | undefined {
  const root = asRecord(error);
  if (root === undefined) return undefined;
  const reason = asRecord(root.reason);
  const reasonHttp = asRecord(reason?.http);
  const http = asRecord(root.http) ?? reasonHttp;
  const response = asRecord(http?.response);
  const metadata = asRecord(root.metadata);
  return (
    numberField(response, "status") ??
    numberField(http, "status") ??
    numberField(metadata, "status") ??
    numberField(metadata, "statusCode") ??
    numberField(root, "statusCode") ??
    numberField(root, "status")
  );
}

function extractReasonTag(error: unknown): string | undefined {
  const root = asRecord(error);
  if (root === undefined) return undefined;
  const tag = stringField(root, "_tag");
  if (tag === "AiError") return stringField(asRecord(root.reason), "_tag");
  return tag;
}

function extractReasonKind(error: unknown): string | undefined {
  const root = asRecord(error);
  if (root === undefined) return undefined;
  const reason = asRecord(root.reason);
  return stringField(reason, "kind") ?? stringField(root, "kind");
}

function extractReasonDescription(error: unknown): string | undefined {
  const root = asRecord(error);
  const reason = asRecord(root?.reason);
  return (
    stringField(reason, "description") ??
    stringField(root, "description") ??
    stringField(root, "message")
  );
}

// ─── Classification ──────────────────────────────────────────────────────────

function classificationFromErrorType(
  errorType: string | undefined,
): CloudModelFailureClassification | undefined {
  if (errorType === undefined) return undefined;
  const normalized = errorType.trim().toLowerCase();
  return RETRYABLE_ERROR_TYPES[normalized] ?? PERMANENT_ERROR_TYPES[normalized];
}

function classificationFromStatus(
  status: number | undefined,
): CloudModelFailureClassification | undefined {
  if (status === undefined) return undefined;
  if (status === 401) return { kind: "permanent", reason: "authentication" };
  if (status === 402) return { kind: "permanent", reason: "payment-required" };
  if (status === 403) return { kind: "permanent", reason: "authorization" };
  if (status === 408) return { kind: "retryable", reason: "timeout" };
  if (status === 429) return { kind: "retryable", reason: "rate-limit" };
  if (status >= 500) return { kind: "retryable", reason: "provider-unavailable" };
  if (status >= 400) return { kind: "permanent", reason: "invalid-request" };
  return undefined;
}

function classificationFromReasonTag(input: {
  readonly tag: string | undefined;
  readonly kind: string | undefined;
  readonly status: number | undefined;
  readonly description: string | undefined;
}): CloudModelFailureClassification | undefined {
  switch (input.tag) {
    case "AuthenticationError": {
      const isAuthorization = input.kind === "InsufficientPermissions" || input.status === 403;
      return { kind: "permanent", reason: isAuthorization ? "authorization" : "authentication" };
    }
    case "QuotaExhaustedError":
      return { kind: "permanent", reason: "payment-required" };
    case "ContentPolicyError":
      return { kind: "permanent", reason: "authorization" };
    case "RateLimitError":
      return { kind: "retryable", reason: "rate-limit" };
    case "InvalidRequestError":
    case "InvalidUserInputError":
      return { kind: "permanent", reason: "invalid-request" };
    case "InternalProviderError":
      return { kind: "retryable", reason: "provider-unavailable" };
    case "NetworkError": {
      const description = (input.description ?? "").toLowerCase();
      if (description.includes("timeout") || description.includes("timed out")) {
        return { kind: "retryable", reason: "timeout" };
      }
      return { kind: "retryable", reason: "network" };
    }
    case "InvalidOutputError":
    case "StructuredOutputError":
    case "UnsupportedSchemaError":
    case "ToolNotFoundError":
    case "ToolParameterValidationError":
    case "InvalidToolResultError":
    case "ToolResultEncodingError":
    case "ToolConfigurationError":
    case "ToolkitRequiredError":
      return UNKNOWN_RETRYABLE;
    default:
      return undefined;
  }
}

type MessageNeedleClassification = {
  readonly needles: readonly string[];
  readonly classification: CloudModelFailureClassification;
};

const PERMANENT_MESSAGE_NEEDLES: readonly MessageNeedleClassification[] = [
  {
    needles: ["401", "unauthorized", "invalid api key", "invalid credentials", "authentication"],
    classification: { kind: "permanent", reason: "authentication" },
  },
  {
    needles: ["402", "payment required", "insufficient credit", "insufficient_quota"],
    classification: { kind: "permanent", reason: "payment-required" },
  },
  {
    needles: ["403", "forbidden", "permission denied", "permission_denied", "guardrail"],
    classification: { kind: "permanent", reason: "authorization" },
  },
  {
    needles: [
      "400",
      "413",
      "invalid request",
      "invalid_request",
      "context length",
      "context_length",
      "maximum context length",
      "too large",
      "max size",
    ],
    classification: { kind: "permanent", reason: "invalid-request" },
  },
];

const RETRYABLE_MESSAGE_NEEDLES: readonly MessageNeedleClassification[] = [
  {
    needles: ["429", "rate limit", "rate_limit", "too many requests"],
    classification: { kind: "retryable", reason: "rate-limit" },
  },
  {
    needles: ["overloaded", "529"],
    classification: { kind: "retryable", reason: "provider-overloaded" },
  },
  {
    needles: ["no provider available", "provider unavailable", "provider_unavailable"],
    classification: { kind: "retryable", reason: "provider-unavailable" },
  },
  {
    needles: ["408", "timeout", "timed out"],
    classification: { kind: "retryable", reason: "timeout" },
  },
  {
    needles: [
      "500",
      "502",
      "503",
      "504",
      "network",
      "fetch failed",
      "connection",
      "socket",
      "econnrefused",
      "econnreset",
      "enotfound",
    ],
    classification: { kind: "retryable", reason: "network" },
  },
];

function classificationFromMessage(
  message: string | undefined,
): CloudModelFailureClassification | undefined {
  if (message === undefined) return undefined;
  const normalized = message.toLowerCase();
  for (const entry of PERMANENT_MESSAGE_NEEDLES) {
    if (entry.needles.some((needle) => normalized.includes(needle))) {
      return entry.classification;
    }
  }
  for (const entry of RETRYABLE_MESSAGE_NEEDLES) {
    if (entry.needles.some((needle) => normalized.includes(needle))) {
      return entry.classification;
    }
  }
  return undefined;
}

/**
 * Classify a cloud model failure into permanent (fail the job) or retryable
 * (continue through the attempt plan) behavior.
 *
 * Reads OpenRouter `error.metadata.error_type` documents, Effect `AiError`
 * reasons with HTTP context, provider config errors, and transport errors.
 */
export function classifyCloudModelFailure(error: unknown): CloudModelFailureClassification {
  const errorType = classificationFromErrorType(extractErrorType(error));
  if (errorType !== undefined) return errorType;

  const status = extractHttpStatus(error);
  const fromReason = classificationFromReasonTag({
    tag: extractReasonTag(error),
    kind: extractReasonKind(error),
    status,
    description: extractReasonDescription(error),
  });
  if (fromReason !== undefined) return fromReason;

  const fromStatus = classificationFromStatus(status);
  if (fromStatus !== undefined) return fromStatus;

  if (error instanceof AutoPrConfigError) {
    return { kind: "permanent", reason: "authentication" };
  }

  const message = extractReasonDescription(error);
  return classificationFromMessage(message) ?? UNKNOWN_RETRYABLE;
}

/** True when the attempt plan should retry within the same model attempt. */
export function shouldRetryCloudModelAttempt(error: unknown): boolean {
  return classifyCloudModelFailure(error).kind !== "permanent";
}

// ─── Attempt plan ────────────────────────────────────────────────────────────

function catalogFallbackAttempt(input: {
  readonly band: ModelBand;
  readonly selectedModel: string;
  readonly requiresToolCalls: boolean;
  readonly entries: readonly OpenRouterModelCatalogEntry[];
}): OpenRouterModelAttempt | undefined {
  const selection = pickOpenRouterModelCatalogEntry({
    band: input.band,
    entries: input.entries.filter((entry) => entry.id !== input.selectedModel),
    requiresToolCalls: input.requiresToolCalls,
  });
  if (selection.model === input.selectedModel) return undefined;
  // A tool-required route must never degrade to a text-only request; skip the
  // catalog entry instead of accepting the picker's no-tools fallback.
  if (input.requiresToolCalls && !selection.requiresToolCalls) return undefined;
  return {
    provider: "openrouter",
    model: selection.model,
    requiresToolCalls: selection.requiresToolCalls,
    selectionMode: selection.catalogEntry === undefined ? "static-fallback" : "catalog-fallback",
  };
}

/**
 * Build the ordered AI attempt plan:
 *
 * 1. selected OpenRouter model (with or without tools, matching the route)
 * 2. different free catalog fallback with the same tool requirement
 * 3. optional local fallback with the same tool requirement
 *
 * The primitive commit-derived fallback is not an AI attempt; the caller moves
 * to it via `decideCloudModelFallback` once the plan is exhausted.
 */
export function buildOpenRouterModelAttemptPlan(input: {
  readonly band: ModelBand;
  readonly selectedModel: string;
  readonly requiresToolCalls: boolean;
  readonly entries: readonly OpenRouterModelCatalogEntry[];
  readonly localFallback?: OpenRouterLocalFallback;
}): readonly OpenRouterModelAttempt[] {
  const attempts: OpenRouterModelAttempt[] = [
    {
      provider: "openrouter",
      model: input.selectedModel,
      requiresToolCalls: input.requiresToolCalls,
      selectionMode: "selected",
    },
  ];

  const fallback = catalogFallbackAttempt(input);
  if (fallback !== undefined) attempts.push(fallback);

  if (input.localFallback !== undefined) {
    attempts.push({
      provider: "local",
      model: input.localFallback.model,
      requiresToolCalls: input.requiresToolCalls,
      selectionMode: input.localFallback.selectionMode ?? "local-fallback",
    });
  }

  return attempts;
}

/**
 * Decide what happens after a failed AI attempt:
 *
 * - permanent auth/quota/request failures fail the job;
 * - retryable failures move to the next planned attempt;
 * - exhausted plans fall back to primitive commit-derived content.
 */
export function decideCloudModelFallback(input: {
  readonly failure: CloudModelFailureClassification;
  readonly hasRemainingAttempts: boolean;
}): CloudModelFallbackDecision {
  if (input.failure.kind === "permanent") return "fail";
  return input.hasRemainingAttempts ? "next_attempt" : "final_fallback";
}
