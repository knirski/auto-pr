import { describe, expect, test } from "bun:test";
import { Duration, Effect, Fiber, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { makeOpenRouterModelsRepositoryLive, OpenRouterModelsRepository } from "#auto-pr";
import { runEffect } from "#test/run-effect.js";
import { TestBaseLayer } from "#test/test-utils.js";

/**
 * Wire fixture copied from a live
 * `GET https://openrouter.ai/api/v1/models?limit=1` response. The generated
 * OpenRouter client schema validates this shape strictly, so tests must keep
 * snake_case fields and required keys (`links`, `total_count`, model metadata).
 */
const realModelsResponse = {
  data: [
    {
      id: "typesafe/jev-router",
      canonical_slug: "typesafe/jev-router",
      hugging_face_id: null,
      name: "TypeSafe: Jev Router",
      created: 1790363560,
      description:
        "Jev Router picks the best model and reasoning effort for each request, balancing quality, speed, and cost.",
      context_length: 1000000,
      architecture: {
        modality: "text+image+file+audio+video->text",
        input_modalities: ["audio", "file", "image", "text", "video"],
        output_modalities: ["text"],
        tokenizer: "Router",
        instruct_type: null,
      },
      pricing: { prompt: "-1", completion: "-1" },
      top_provider: {
        context_length: null,
        max_completion_tokens: null,
        is_moderated: false,
      },
      per_request_limits: null,
      supported_parameters: [],
      default_parameters: {},
      supported_voices: null,
      knowledge_cutoff: null,
      expiration_date: null,
      links: { details: "/api/v1/models/typesafe/jev-router/endpoints" },
    },
  ],
  total_count: 458,
  links: { next: "/api/v1/models?offset=1&limit=1" },
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Typed fetch mock: `typeof fetch` requires the Bun `preconnect` hook. */
function makeFetchImpl(
  impl: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
): typeof fetch {
  return Object.assign(impl, { preconnect: fetch.preconnect }) satisfies typeof fetch;
}

type CapturedRequest = {
  readonly url: string;
  readonly headers: Headers;
};

describe("OpenRouterModelsRepositoryLive", () => {
  test("fetchModels calls the OpenRouter models endpoint with bearer auth", async () => {
    const calls: CapturedRequest[] = [];
    const fetchImpl = makeFetchImpl(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push({ url: request.url, headers: request.headers });
      return jsonResponse(realModelsResponse);
    });

    const layer = makeOpenRouterModelsRepositoryLive({
      apiKey: Redacted.make("sk-or-test", { label: "OPENROUTER_API_KEY" }),
      fetchImpl,
    });

    await runEffect(Layer.mergeAll(TestBaseLayer, layer))(
      Effect.gen(function* () {
        const repository = yield* OpenRouterModelsRepository;
        const models = yield* repository.fetchModels();
        expect(models.map((model) => model.id)).toEqual(["typesafe/jev-router"]);
        expect(models[0]?.name).toBe("TypeSafe: Jev Router");
        expect(models[0]?.contextLength).toBe(1_000_000);
        expect(models[0]?.outputModalities).toEqual(["text"]);
        expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/models?limit=1000");
        expect(calls[0]?.headers.get("authorization")).toBe("Bearer sk-or-test");
      }),
    );
  });

  test("omits bearer auth when no api key is provided", async () => {
    const calls: CapturedRequest[] = [];
    const fetchImpl = makeFetchImpl(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push({ url: request.url, headers: request.headers });
      return jsonResponse(realModelsResponse);
    });

    const layer = makeOpenRouterModelsRepositoryLive({ fetchImpl });

    await runEffect(Layer.mergeAll(TestBaseLayer, layer))(
      Effect.gen(function* () {
        const repository = yield* OpenRouterModelsRepository;
        const models = yield* repository.fetchModels();
        expect(models.map((model) => model.id)).toEqual(["typesafe/jev-router"]);
        expect(calls[0]?.headers.get("authorization")).toBeNull();
      }),
    );
  });

  test("returns an empty catalog on non-2xx responses", async () => {
    const layer = makeOpenRouterModelsRepositoryLive({
      fetchImpl: makeFetchImpl(async () => new Response("bad", { status: 503 })),
    });

    await runEffect(Layer.mergeAll(TestBaseLayer, layer))(
      Effect.gen(function* () {
        const repository = yield* OpenRouterModelsRepository;
        expect(yield* repository.fetchModels()).toEqual([]);
      }),
    );
  });

  test("returns an empty catalog when the payload fails schema decoding", async () => {
    const layer = makeOpenRouterModelsRepositoryLive({
      fetchImpl: makeFetchImpl(async () => jsonResponse({ data: [{ id: "broken" }] })),
    });

    await runEffect(Layer.mergeAll(TestBaseLayer, layer))(
      Effect.gen(function* () {
        const repository = yield* OpenRouterModelsRepository;
        expect(yield* repository.fetchModels()).toEqual([]);
      }),
    );
  });

  test("aborts a stalled catalog fetch after the timeout and returns an empty catalog", async () => {
    let sawAbort = false;
    const fetchImpl = Object.assign(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new Promise<Response>((resolve) => {
          const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
          if (!(signal instanceof AbortSignal)) return;
          const resolveEmptyCatalog = () => {
            sawAbort = true;
            resolve(jsonResponse({ data: [], total_count: 0, links: { next: null } }));
          };
          if (signal.aborted) {
            resolveEmptyCatalog();
            return;
          }
          signal.addEventListener("abort", resolveEmptyCatalog, { once: true });
        }),
      { preconnect: fetch.preconnect },
    ) satisfies typeof fetch;

    const testEffect = Effect.gen(function* () {
      const repository = yield* OpenRouterModelsRepository;
      const fiber = yield* Effect.forkChild(repository.fetchModels());
      yield* TestClock.adjust(Duration.seconds(6));
      const models = yield* Fiber.join(fiber);
      expect(models).toEqual([]);
      expect(sawAbort).toBe(true);
    }).pipe(
      Effect.provide(makeOpenRouterModelsRepositoryLive({ fetchImpl })),
      Effect.provide(TestClock.layer()),
      Effect.scoped,
    );

    await Effect.runPromise(testEffect);
  });
});
