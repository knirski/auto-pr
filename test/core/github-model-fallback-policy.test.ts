import { describe, expect, test } from "bun:test";
import {
  buildGithubModelAttemptPlan,
  CapabilityMismatchFailure,
  classifyGithubModelFailure,
  decideGithubModelFallback,
  TransientFailure,
} from "../../src/core/github-model-fallback-policy.js";
import type { GithubModelCatalogEntry } from "../../src/core/github-model-routing.js";

function model(input: {
  readonly id: string;
  readonly tier: GithubModelCatalogEntry["rateLimitTier"];
  readonly tool: boolean;
}): GithubModelCatalogEntry {
  return {
    id: input.id,
    name: input.id,
    capabilities: input.tool ? ["tool-calling"] : ["streaming"],
    supportedInputModalities: ["text"],
    supportedOutputModalities: ["text"],
    maxInputTokens: 8_000,
    maxOutputTokens: 2_000,
    rateLimitTier: input.tier,
  };
}

describe("github-model-fallback-policy", () => {
  test("builds attempt plan with progressive fallbacks", () => {
    const attempts = buildGithubModelAttemptPlan({
      selectedModel: "a",
      requiresToolCalls: true,
      entries: [
        model({ id: "a", tier: "high", tool: false }),
        model({ id: "b", tier: "high", tool: true }),
        model({ id: "c", tier: "low", tool: true }),
        model({ id: "d", tier: "low", tool: false }),
      ],
      maxAttempts: 6,
    });
    expect(attempts.length).toBeGreaterThan(1);
    expect(attempts[0]).toMatchObject({
      model: "b",
      requiresToolCalls: true,
    });
  });

  test("respects minimum maxAttempts and avoids duplicates", () => {
    const attempts = buildGithubModelAttemptPlan({
      selectedModel: "only",
      requiresToolCalls: true,
      entries: [model({ id: "only", tier: "high", tool: true })],
      maxAttempts: 0,
    });
    expect(attempts).toEqual([
      {
        model: "only",
        requiresToolCalls: true,
        selectionMode: "preferred",
      },
    ]);
  });

  test("classifies ai error tags", () => {
    expect(classifyGithubModelFailure({ reason: { _tag: "AuthenticationError" } })).toEqual({
      _tag: "AuthOrConfig",
    });
    expect(classifyGithubModelFailure({ reason: { _tag: "RateLimitError" } })).toEqual({
      _tag: "RateLimited",
    });
    expect(classifyGithubModelFailure({ reason: { _tag: "NetworkError" } })).toEqual({
      _tag: "Transient",
    });
    expect(classifyGithubModelFailure({ reason: { _tag: "InternalProviderError" } })).toBe(
      TransientFailure,
    );
    expect(
      classifyGithubModelFailure({
        reason: { _tag: "InvalidRequestError" },
        message: "tools are not supported",
      }),
    ).toEqual({ _tag: "CapabilityMismatch" });
    expect(
      classifyGithubModelFailure({
        reason: { _tag: "InvalidRequestError" },
        message: "Request body too large for gpt-4.1 model. Max size: 8000 tokens.",
      }),
    ).toEqual({ _tag: "CapabilityMismatch" });
  });

  test("classifies plain error messages", () => {
    expect(classifyGithubModelFailure(new Error("401 unauthorized"))).toEqual({
      _tag: "AuthOrConfig",
    });
    expect(classifyGithubModelFailure(new Error("429 rate limit exceeded"))).toEqual({
      _tag: "RateLimited",
    });
    expect(classifyGithubModelFailure(new Error("function_call is not supported"))).toBe(
      CapabilityMismatchFailure,
    );
    expect(
      classifyGithubModelFailure(
        new Error(
          "OpenAiClient.createResponse: Request body too large for gpt-4.1 model. Max size: 8000 tokens.",
        ),
      ),
    ).toBe(CapabilityMismatchFailure);
    expect(classifyGithubModelFailure(new Error("request timeout"))).toEqual({ _tag: "Transient" });
    expect(classifyGithubModelFailure(new Error("other"))).toEqual({ _tag: "Unknown" });
  });

  test("decides fallback transitions", () => {
    expect(
      decideGithubModelFallback({ failure: { _tag: "RateLimited" }, hasRemainingAttempts: true }),
    ).toBe("next_attempt");
    expect(
      decideGithubModelFallback({ failure: { _tag: "AuthOrConfig" }, hasRemainingAttempts: true }),
    ).toBe("final_fallback");
    expect(
      decideGithubModelFallback({ failure: { _tag: "Transient" }, hasRemainingAttempts: false }),
    ).toBe("final_fallback");
  });
});
