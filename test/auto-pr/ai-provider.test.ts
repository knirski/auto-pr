import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Redacted, Result } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { AutoPrConfigError } from "#auto-pr";
import { aiProviderLayerFromConfig } from "#auto-pr/live/ai-provider.js";
import { runEffect } from "#test/run-effect.js";
import {
  createOpenAiChatCompletionsMockFetch,
  SilentLoggerLayer,
  TestBaseLayer,
} from "#test/test-utils.js";

const BaseLayer = Layer.mergeAll(TestBaseLayer, SilentLoggerLayer);

describe("aiProviderLayerFromConfig", () => {
  test("local: builds layer that provides LanguageModel", async () => {
    const layer = Layer.mergeAll(
      BaseLayer,
      aiProviderLayerFromConfig(
        { provider: "local", model: "gpt-oss" },
        { fetch: createOpenAiChatCompletionsMockFetch("{}") },
      ),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const model = yield* LanguageModel.LanguageModel;
        expect(model).toBeDefined();
      }).pipe(Effect.scoped),
    );
  });

  test("github-models: builds layer when ghToken and model provided", async () => {
    const layer = Layer.mergeAll(
      BaseLayer,
      aiProviderLayerFromConfig({
        provider: "github-models",
        model: "openai/gpt-4",
        ghToken: Redacted.make("ghp_test", { label: "GH_TOKEN" }),
      }),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const model = yield* LanguageModel.LanguageModel;
        expect(model).toBeDefined();
      }).pipe(Effect.scoped),
    );
  });

  test("github-models: fails with AutoPrConfigError when ghToken empty", async () => {
    const layer = Layer.mergeAll(
      BaseLayer,
      aiProviderLayerFromConfig({
        provider: "github-models",
        model: "openai/gpt-4",
        ghToken: Redacted.make("", { label: "GH_TOKEN" }),
      }),
    );
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* LanguageModel.LanguageModel;
      }).pipe(Effect.scoped, Effect.provide(layer), Effect.exit),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      Result.match(Cause.findError(exit.cause), {
        onSuccess: (err) => expect(err).toBeInstanceOf(AutoPrConfigError),
        onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
      });
    }
  });

  test("github-models: fails with AutoPrConfigError when model empty", async () => {
    const layer = Layer.mergeAll(
      BaseLayer,
      aiProviderLayerFromConfig({
        provider: "github-models",
        model: "",
        ghToken: Redacted.make("ghp_test", { label: "GH_TOKEN" }),
      }),
    );
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* LanguageModel.LanguageModel;
      }).pipe(Effect.scoped, Effect.provide(layer), Effect.exit),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      Result.match(Cause.findError(exit.cause), {
        onSuccess: (err) => expect(err).toBeInstanceOf(AutoPrConfigError),
        onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
      });
    }
  });

  test("local: builds layer when url, apiKey, and model provided", async () => {
    const layer = Layer.mergeAll(
      BaseLayer,
      aiProviderLayerFromConfig({
        provider: "local",
        model: "gpt-4",
        openaiCompatUrl: "https://api.example.com/v1",
        openaiCompatApiKey: Redacted.make("sk-test", {
          label: "AUTO_PR_AI_OPENAI_COMPAT_API_KEY",
        }),
      }),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const model = yield* LanguageModel.LanguageModel;
        expect(model).toBeDefined();
      }).pipe(Effect.scoped),
    );
  });

  test("local: builds layer when apiKey empty (optional for local endpoints)", async () => {
    const layer = Layer.mergeAll(
      BaseLayer,
      aiProviderLayerFromConfig({
        provider: "local",
        model: "gpt-4",
        openaiCompatUrl: "https://api.example.com/v1",
        openaiCompatApiKey: Redacted.make("", {
          label: "AUTO_PR_AI_OPENAI_COMPAT_API_KEY",
        }),
      }),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const model = yield* LanguageModel.LanguageModel;
        expect(model).toBeDefined();
      }).pipe(Effect.scoped),
    );
  });

  test("local: builds layer when url omitted (default base URL)", async () => {
    const layer = Layer.mergeAll(
      BaseLayer,
      aiProviderLayerFromConfig({
        provider: "local",
        model: "gpt-4",
        openaiCompatApiKey: Redacted.make("sk-test", {
          label: "AUTO_PR_AI_OPENAI_COMPAT_API_KEY",
        }),
      }),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const model = yield* LanguageModel.LanguageModel;
        expect(model).toBeDefined();
      }).pipe(Effect.scoped),
    );
  });
});
