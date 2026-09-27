import { describe, expect, test } from "bun:test";
import { AutoPrConfigError, DescriptionParseError } from "#core/errors.js";
import {
  buildOpenRouterModelAttemptPlan,
  type CloudModelFailureClassification,
  classifyCloudModelFailure,
  decideCloudModelFallback,
  shouldRetryCloudModelAttempt,
} from "#core/openrouter-fallback-policy.js";
import {
  DEFAULT_OPENROUTER_MODEL,
  type OpenRouterModelCatalogEntry,
} from "#core/openrouter-routing.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

type AiErrorFixtureInput = {
  readonly reasonTag: string;
  readonly status?: number;
  readonly kind?: string;
  readonly description?: string;
  readonly errorType?: string;
  readonly message?: string;
};

/**
 * Build an `AiError`-shaped fixture close to what `@effect/ai-openrouter`
 * produces: HTTP status under `reason.http.response.status` and OpenRouter
 * metadata under `reason.metadata.openrouter`.
 */
function makeAiError(input: AiErrorFixtureInput): unknown {
  const message = input.message ?? "provider failed";
  return {
    _tag: "AiError",
    module: "OpenRouterClient",
    method: "generateText",
    message,
    reason: {
      _tag: input.reasonTag,
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.status === undefined
        ? {}
        : {
            http: {
              request: {
                method: "POST",
                url: "https://openrouter.ai/api/v1/chat/completions",
                urlParams: [],
                headers: {},
              },
              response: { status: input.status, headers: {} },
              body: JSON.stringify({
                error: {
                  code: input.status,
                  message,
                  ...(input.errorType === undefined
                    ? {}
                    : { metadata: { error_type: input.errorType } }),
                },
              }),
            },
          }),
      metadata: {
        openrouter: {
          errorCode: input.status ?? null,
          errorType: input.errorType ?? null,
          requestId: null,
        },
      },
    },
  };
}

function freePricing(): OpenRouterModelCatalogEntry["pricing"] {
  return {
    prompt: 0,
    completion: 0,
    request: 0,
    image: 0,
    imageOutput: 0,
    imageToken: 0,
    audio: 0,
    audioOutput: 0,
    webSearch: 0,
    internalReasoning: 0,
    inputCacheRead: 0,
    inputCacheWrite: 0,
    inputCacheWrite1h: 0,
    overrides: [],
    unknownPriceKeys: [],
  };
}

function freeEntry(input: {
  readonly id: string;
  readonly supportedParameters?: readonly string[];
}): OpenRouterModelCatalogEntry {
  return {
    id: input.id,
    name: input.id,
    contextLength: 131_072,
    supportedParameters: input.supportedParameters ?? ["tools", "tool_choice", "max_tokens"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    pricing: freePricing(),
  };
}

const toolEntry = freeEntry({ id: "openai/gpt-oss-20b:free" });
const toolFallbackEntry = freeEntry({ id: "google/gemma-4-26b-a4b-it:free" });
const textOnlyEntry = freeEntry({
  id: "cohere/north-mini-code:free",
  supportedParameters: ["max_tokens"],
});

// ─── Classification ──────────────────────────────────────────────────────────

describe("classifyCloudModelFailure", () => {
  test("treats authentication, payment, authorization, and invalid requests as permanent", () => {
    expect(
      classifyCloudModelFailure(makeAiError({ reasonTag: "AuthenticationError", status: 401 })),
    ).toEqual({
      kind: "permanent",
      reason: "authentication",
    });
    expect(
      classifyCloudModelFailure(makeAiError({ reasonTag: "UnknownError", status: 402 })),
    ).toEqual({
      kind: "permanent",
      reason: "payment-required",
    });
    expect(
      classifyCloudModelFailure(makeAiError({ reasonTag: "AuthenticationError", status: 403 })),
    ).toEqual({ kind: "permanent", reason: "authorization" });
    expect(
      classifyCloudModelFailure(makeAiError({ reasonTag: "InvalidRequestError", status: 400 })),
    ).toEqual({
      kind: "permanent",
      reason: "invalid-request",
    });
  });

  test("treats rate limits, timeouts, and provider availability as retryable", () => {
    expect(
      classifyCloudModelFailure(makeAiError({ reasonTag: "RequestTimeoutError", status: 408 })),
    ).toEqual({
      kind: "retryable",
      reason: "timeout",
    });
    expect(
      classifyCloudModelFailure(makeAiError({ reasonTag: "RateLimitError", status: 429 })),
    ).toEqual({
      kind: "retryable",
      reason: "rate-limit",
    });
    expect(
      classifyCloudModelFailure(makeAiError({ reasonTag: "InternalProviderError", status: 502 })),
    ).toEqual({
      kind: "retryable",
      reason: "provider-unavailable",
    });
    expect(
      classifyCloudModelFailure(makeAiError({ reasonTag: "InternalProviderError", status: 503 })),
    ).toEqual({
      kind: "retryable",
      reason: "provider-unavailable",
    });
    expect(
      classifyCloudModelFailure(makeAiError({ reasonTag: "InternalProviderError", status: 500 })),
    ).toEqual({
      kind: "retryable",
      reason: "provider-unavailable",
    });
  });

  test("maps OpenRouter error.metadata.error_type values", () => {
    const cases: ReadonlyArray<readonly [string, CloudModelFailureClassification]> = [
      ["rate_limit_exceeded", { kind: "retryable", reason: "rate-limit" }],
      ["provider_overloaded", { kind: "retryable", reason: "provider-overloaded" }],
      ["provider_unavailable", { kind: "retryable", reason: "provider-unavailable" }],
      ["authentication", { kind: "permanent", reason: "authentication" }],
      ["permission_denied", { kind: "permanent", reason: "authorization" }],
      ["payment_required", { kind: "permanent", reason: "payment-required" }],
      ["invalid_request", { kind: "permanent", reason: "invalid-request" }],
      ["context_length_exceeded", { kind: "permanent", reason: "invalid-request" }],
    ];
    for (const [errorType, expected] of cases) {
      expect(
        classifyCloudModelFailure(makeAiError({ reasonTag: "UnknownError", errorType })),
      ).toEqual(expected);
    }
  });

  test("reads flat error.metadata.error_type documents", () => {
    expect(classifyCloudModelFailure({ metadata: { error_type: "provider_overloaded" } })).toEqual({
      kind: "retryable",
      reason: "provider-overloaded",
    });
    expect(classifyCloudModelFailure({ metadata: { error_type: "payment_required" } })).toEqual({
      kind: "permanent",
      reason: "payment-required",
    });
  });

  test("reads error_type from the OpenRouter wire body", () => {
    expect(
      classifyCloudModelFailure({
        reason: {
          _tag: "UnknownError",
          http: {
            body: JSON.stringify({
              error: {
                code: 400,
                message: "bad",
                metadata: { error_type: "context_length_exceeded" },
              },
            }),
          },
        },
      }),
    ).toEqual({ kind: "permanent", reason: "invalid-request" });
  });

  test("treats quota exhaustion and authentication reasons as permanent without a status", () => {
    expect(classifyCloudModelFailure(makeAiError({ reasonTag: "QuotaExhaustedError" }))).toEqual({
      kind: "permanent",
      reason: "payment-required",
    });
    expect(
      classifyCloudModelFailure(
        makeAiError({ reasonTag: "AuthenticationError", kind: "InvalidKey" }),
      ),
    ).toEqual({ kind: "permanent", reason: "authentication" });
    expect(
      classifyCloudModelFailure(
        makeAiError({ reasonTag: "AuthenticationError", kind: "InsufficientPermissions" }),
      ),
    ).toEqual({ kind: "permanent", reason: "authorization" });
    expect(classifyCloudModelFailure(makeAiError({ reasonTag: "ContentPolicyError" }))).toEqual({
      kind: "permanent",
      reason: "authorization",
    });
  });

  test("treats network transport errors as retryable and preserves timeout hints", () => {
    expect(
      classifyCloudModelFailure(
        makeAiError({ reasonTag: "NetworkError", description: "Connection refused" }),
      ),
    ).toEqual({ kind: "retryable", reason: "network" });
    expect(
      classifyCloudModelFailure(
        makeAiError({
          reasonTag: "NetworkError",
          description: "Connection timeout after 30 seconds",
        }),
      ),
    ).toEqual({ kind: "retryable", reason: "timeout" });
    expect(classifyCloudModelFailure(new Error("socket hang up"))).toEqual({
      kind: "retryable",
      reason: "network",
    });
  });

  test("keeps status-less unknown transport errors retryable", () => {
    expect(classifyCloudModelFailure(makeAiError({ reasonTag: "UnknownError" }))).toEqual({
      kind: "unknown-retryable",
      reason: "unknown",
    });
    expect(classifyCloudModelFailure(new Error("boom"))).toEqual({
      kind: "unknown-retryable",
      reason: "unknown",
    });
    expect(classifyCloudModelFailure(undefined)).toEqual({
      kind: "unknown-retryable",
      reason: "unknown",
    });
  });

  test("treats model-output validation failures as retryable", () => {
    expect(classifyCloudModelFailure(new DescriptionParseError({ cause: "invalid JSON" }))).toEqual(
      {
        kind: "unknown-retryable",
        reason: "unknown",
      },
    );
  });

  test("treats provider config errors as permanent", () => {
    expect(
      classifyCloudModelFailure(new AutoPrConfigError({ missing: ["OPENROUTER_API_KEY"] })),
    ).toEqual({
      kind: "permanent",
      reason: "authentication",
    });
  });
});

describe("shouldRetryCloudModelAttempt", () => {
  test("retries retryable and unknown errors but not permanent ones", () => {
    expect(
      shouldRetryCloudModelAttempt(makeAiError({ reasonTag: "RateLimitError", status: 429 })),
    ).toBe(true);
    expect(shouldRetryCloudModelAttempt(makeAiError({ reasonTag: "UnknownError" }))).toBe(true);
    expect(
      shouldRetryCloudModelAttempt(makeAiError({ reasonTag: "AuthenticationError", status: 401 })),
    ).toBe(false);
    expect(
      shouldRetryCloudModelAttempt(makeAiError({ reasonTag: "UnknownError", status: 402 })),
    ).toBe(false);
  });
});

// ─── Attempt plan ─────────────────────────────────────────────────────────────

describe("buildOpenRouterModelAttemptPlan", () => {
  test("plans selected model, different catalog fallback, and local fallback with tools on a tool route", () => {
    const plan = buildOpenRouterModelAttemptPlan({
      band: "B",
      selectedModel: toolEntry.id,
      requiresToolCalls: true,
      entries: [toolEntry, toolFallbackEntry],
      localFallback: { model: "gpt-oss" },
    });

    expect(plan).toEqual([
      {
        provider: "openrouter",
        model: "openai/gpt-oss-20b:free",
        requiresToolCalls: true,
        selectionMode: "selected",
      },
      {
        provider: "openrouter",
        model: "google/gemma-4-26b-a4b-it:free",
        requiresToolCalls: true,
        selectionMode: "catalog-fallback",
      },
      {
        provider: "local",
        model: "gpt-oss",
        requiresToolCalls: true,
        selectionMode: "local-fallback",
      },
    ]);
    expect(plan.every((attempt) => attempt.requiresToolCalls)).toBe(true);
  });

  test("never plans a no-tools AI attempt when tools are required", () => {
    const plan = buildOpenRouterModelAttemptPlan({
      band: "B",
      selectedModel: toolEntry.id,
      requiresToolCalls: true,
      entries: [textOnlyEntry],
      localFallback: { model: "gpt-oss" },
    });

    expect(plan).toEqual([
      {
        provider: "openrouter",
        model: "openai/gpt-oss-20b:free",
        requiresToolCalls: true,
        selectionMode: "selected",
      },
      {
        provider: "local",
        model: "gpt-oss",
        requiresToolCalls: true,
        selectionMode: "local-fallback",
      },
    ]);
    expect(plan.some((attempt) => attempt.requiresToolCalls === false)).toBe(false);
  });

  test("plans selected model, different text fallback, and local fallback without tools when tools are not required", () => {
    const plan = buildOpenRouterModelAttemptPlan({
      band: "B",
      selectedModel: toolEntry.id,
      requiresToolCalls: false,
      entries: [toolEntry, toolFallbackEntry],
      localFallback: { model: "gpt-oss" },
    });

    expect(plan).toEqual([
      {
        provider: "openrouter",
        model: "openai/gpt-oss-20b:free",
        requiresToolCalls: false,
        selectionMode: "selected",
      },
      {
        provider: "openrouter",
        model: "google/gemma-4-26b-a4b-it:free",
        requiresToolCalls: false,
        selectionMode: "catalog-fallback",
      },
      {
        provider: "local",
        model: "gpt-oss",
        requiresToolCalls: false,
        selectionMode: "local-fallback",
      },
    ]);
    expect(plan.every((attempt) => attempt.requiresToolCalls === false)).toBe(true);
  });

  test("keeps only the selected attempt when the catalog offers nothing different", () => {
    const plan = buildOpenRouterModelAttemptPlan({
      band: "C",
      selectedModel: DEFAULT_OPENROUTER_MODEL,
      requiresToolCalls: true,
      entries: [toolEntry],
    });

    expect(plan).toEqual([
      {
        provider: "openrouter",
        model: DEFAULT_OPENROUTER_MODEL,
        requiresToolCalls: true,
        selectionMode: "selected",
      },
    ]);
  });

  test("uses the static free model as a fallback when the catalog is unavailable", () => {
    const plan = buildOpenRouterModelAttemptPlan({
      band: "B",
      selectedModel: "google/gemma-4-26b-a4b-it:free",
      requiresToolCalls: true,
      entries: [],
    });

    expect(plan).toEqual([
      {
        provider: "openrouter",
        model: "google/gemma-4-26b-a4b-it:free",
        requiresToolCalls: true,
        selectionMode: "selected",
      },
      {
        provider: "openrouter",
        model: DEFAULT_OPENROUTER_MODEL,
        requiresToolCalls: true,
        selectionMode: "static-fallback",
      },
    ]);
  });

  test("accepts an explicit local fallback selection mode for logging", () => {
    const plan = buildOpenRouterModelAttemptPlan({
      band: "B",
      selectedModel: toolFallbackEntry.id,
      requiresToolCalls: false,
      entries: [],
      localFallback: { model: "gpt-oss", selectionMode: "local-no-tool-fallback" },
    });

    expect(plan.map((attempt) => attempt.selectionMode)).toEqual([
      "selected",
      "static-fallback",
      "local-no-tool-fallback",
    ]);
  });
});

// ─── Fallback decisions ───────────────────────────────────────────────────────

describe("decideCloudModelFallback", () => {
  const retryable: CloudModelFailureClassification = { kind: "retryable", reason: "rate-limit" };
  const unknownRetryable: CloudModelFailureClassification = {
    kind: "unknown-retryable",
    reason: "unknown",
  };
  const permanent: CloudModelFailureClassification = {
    kind: "permanent",
    reason: "authentication",
  };

  test("retries while attempts remain", () => {
    expect(decideCloudModelFallback({ failure: retryable, hasRemainingAttempts: true })).toBe(
      "next_attempt",
    );
    expect(
      decideCloudModelFallback({ failure: unknownRetryable, hasRemainingAttempts: true }),
    ).toBe("next_attempt");
  });

  test("falls back to the primitive commit-derived content when attempts are exhausted", () => {
    expect(decideCloudModelFallback({ failure: retryable, hasRemainingAttempts: false })).toBe(
      "final_fallback",
    );
    expect(
      decideCloudModelFallback({ failure: unknownRetryable, hasRemainingAttempts: false }),
    ).toBe("final_fallback");
  });

  test("fails the job on permanent failures even with attempts remaining", () => {
    expect(decideCloudModelFallback({ failure: permanent, hasRemainingAttempts: true })).toBe(
      "fail",
    );
    expect(decideCloudModelFallback({ failure: permanent, hasRemainingAttempts: false })).toBe(
      "fail",
    );
  });
});
