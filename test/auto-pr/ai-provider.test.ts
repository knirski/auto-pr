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

/** Typed fetch mock: `typeof fetch` requires the Bun `preconnect` hook. */
function makeFetchImpl(
  impl: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
): typeof fetch {
  return Object.assign(impl, { preconnect: fetch.preconnect }) satisfies typeof fetch;
}

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

  test("openrouter: builds layer when apiKey and model provided", async () => {
    const layer = Layer.mergeAll(
      BaseLayer,
      aiProviderLayerFromConfig({
        provider: "openrouter",
        model: "openai/gpt-oss-20b:free",
        apiKey: Redacted.make("sk-or-test", { label: "OPENROUTER_API_KEY" }),
        title: "auto-pr",
      }),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const model = yield* LanguageModel.LanguageModel;
        expect(model).toBeDefined();
      }).pipe(Effect.scoped),
    );
  });

  test("openrouter: sends OpenRouter base URL, bearer key, and attribution headers", async () => {
    const requests: Request[] = [];
    const fetchImpl = makeFetchImpl(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      return Response.json({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1,
        model: "openai/gpt-oss-20b:free",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        system_fingerprint: null,
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });

    const layer = Layer.mergeAll(
      BaseLayer,
      aiProviderLayerFromConfig(
        {
          provider: "openrouter",
          model: "openai/gpt-oss-20b:free",
          apiKey: Redacted.make("sk-or-test", { label: "OPENROUTER_API_KEY" }),
          httpReferer: "https://github.com/knirski/auto-pr",
          title: "auto-pr",
        },
        { fetch: fetchImpl },
      ),
    );

    await runEffect(layer)(
      Effect.gen(function* () {
        const model = yield* LanguageModel.LanguageModel;
        yield* model.generateText({ prompt: "Say ok" });
      }).pipe(Effect.scoped),
    );

    const request = requests[0];
    expect(request?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(request?.headers.get("authorization")).toBe("Bearer sk-or-test");
    expect(request?.headers.get("http-referer")).toBe("https://github.com/knirski/auto-pr");
    expect(request?.headers.get("x-title")).toBe("auto-pr");
    expect(request?.headers.get("x-openrouter-title")).toBeNull();
  });

  test("openrouter: fails with AutoPrConfigError when apiKey empty", async () => {
    const layer = Layer.mergeAll(
      BaseLayer,
      aiProviderLayerFromConfig({
        provider: "openrouter",
        model: "openai/gpt-oss-20b:free",
        apiKey: Redacted.make("", { label: "OPENROUTER_API_KEY" }),
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

  test("openrouter: fails with AutoPrConfigError when model empty", async () => {
    const layer = Layer.mergeAll(
      BaseLayer,
      aiProviderLayerFromConfig({
        provider: "openrouter",
        model: "",
        apiKey: Redacted.make("sk-or-test", { label: "OPENROUTER_API_KEY" }),
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
