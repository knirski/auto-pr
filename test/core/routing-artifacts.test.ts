import { describe, expect, test } from "bun:test";
import { Result, Schema } from "effect";
import { RoutingDecisionSchema } from "#core/routing-artifacts.js";

describe("RoutingDecisionSchema", () => {
  test("accepts openrouter routing decisions", () => {
    const decoded = Schema.decodeUnknownResult(RoutingDecisionSchema)({
      provider: "openrouter",
      selectedModel: "openai/gpt-oss-20b:free",
      requiresToolCalls: true,
      tokenBudget: 9000,
      selectionMode: "catalog",
    });

    expect(Result.isSuccess(decoded)).toBe(true);
  });

  test("rejects the retired github-models provider", () => {
    const decoded = Schema.decodeUnknownResult(RoutingDecisionSchema)({
      provider: "github-models",
      selectedModel: "microsoft/phi-4-mini-instruct",
      requiresToolCalls: false,
    });

    expect(Result.isFailure(decoded)).toBe(true);
  });
});
