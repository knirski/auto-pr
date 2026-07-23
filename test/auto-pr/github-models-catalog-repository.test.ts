import { describe, expect, test } from "bun:test";
import { Duration, Effect, Fiber, Redacted } from "effect";
import { TestClock } from "effect/testing";
import {
  GithubModelsCatalogRepository,
  makeGithubModelsCatalogRepositoryLive,
} from "#auto-pr/live/github-models-catalog-repository.js";
import { runEffect } from "#test/run-effect.js";

type CapturedRequest = {
  readonly url: string;
  readonly headers: Record<string, string>;
};

/** Builds a fetch mock that resolves to `response` (or rejects) and records the request it received. */
function makeFetchMock(options: {
  readonly response?: Response | (() => Response);
  readonly reject?: unknown;
  readonly captured?: { request?: CapturedRequest };
}): typeof fetch {
  const impl = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (options.captured) {
      const headers: Record<string, string> = {};
      const rawHeaders = init?.headers;
      if (rawHeaders && typeof rawHeaders === "object") {
        for (const [key, value] of Object.entries(rawHeaders as Record<string, string>)) {
          headers[key] = value;
        }
      }
      options.captured.request = { url: String(input), headers };
    }
    if (options.reject !== undefined) {
      return Promise.reject(options.reject);
    }
    const response = typeof options.response === "function" ? options.response() : options.response;
    return Promise.resolve(response ?? new Response("[]", { status: 200 }));
  };
  return Object.assign(impl, { preconnect: fetch.preconnect }) satisfies typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GithubModelsCatalogRepositoryLive", () => {
  test("aborts a stalled catalog fetch after the timeout and returns an empty catalog", async () => {
    let sawAbort = false;
    const fetchImpl = Object.assign(
      (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new Promise<Response>((resolve) => {
          const signal = init?.signal;
          if (!(signal instanceof AbortSignal)) return;
          const resolveEmptyCatalog = () => {
            sawAbort = true;
            resolve(
              new Response("[]", {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
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
      const repository = yield* GithubModelsCatalogRepository;
      const fiber = yield* Effect.forkChild(repository.fetchCatalog(Redacted.make("ghp_test")));
      yield* TestClock.adjust(Duration.seconds(6));
      const entries = yield* Fiber.join(fiber);
      expect(entries).toEqual([]);
      expect(sawAbort).toBe(true);
    }).pipe(
      Effect.provide(makeGithubModelsCatalogRepositoryLive({ fetchImpl })),
      Effect.provide(TestClock.layer()),
      Effect.scoped,
    );

    await Effect.runPromise(testEffect);
  });

  test("parses a well-formed catalog response, trimming ids and reading limits through", async () => {
    const fetchImpl = makeFetchMock({
      response: jsonResponse([
        {
          id: "  openai/gpt-4o  ",
          name: "GPT-4o",
          capabilities: ["tool-calling", "vision"],
          supported_input_modalities: ["text", "image"],
          supported_output_modalities: ["text"],
          limits: { max_input_tokens: 128_000, max_output_tokens: 16_384 },
          rate_limit_tier: "high",
        },
      ]),
    });
    const layer = makeGithubModelsCatalogRepositoryLive({ fetchImpl });

    const entries = await runEffect(layer)(
      GithubModelsCatalogRepository.pipe(
        Effect.flatMap((repository) => repository.fetchCatalog(Redacted.make("ghp_token"))),
      ),
    );

    expect(entries).toEqual([
      {
        id: "openai/gpt-4o",
        name: "GPT-4o",
        capabilities: ["tool-calling", "vision"],
        supportedInputModalities: ["text", "image"],
        supportedOutputModalities: ["text"],
        maxInputTokens: 128_000,
        maxOutputTokens: 16_384,
        rateLimitTier: "high",
      },
    ]);
  });

  test("returns an empty catalog when the top-level payload is not an array", async () => {
    const layer = makeGithubModelsCatalogRepositoryLive({
      fetchImpl: makeFetchMock({ response: jsonResponse({ models: [] }) }),
    });
    const entries = await runEffect(layer)(
      GithubModelsCatalogRepository.pipe(
        Effect.flatMap((repository) => repository.fetchCatalog(Redacted.make("ghp_token"))),
      ),
    );
    expect(entries).toEqual([]);
  });

  test("returns an empty catalog when the top-level payload is null", async () => {
    const layer = makeGithubModelsCatalogRepositoryLive({
      fetchImpl: makeFetchMock({ response: jsonResponse(null) }),
    });
    const entries = await runEffect(layer)(
      GithubModelsCatalogRepository.pipe(
        Effect.flatMap((repository) => repository.fetchCatalog(Redacted.make("ghp_token"))),
      ),
    );
    expect(entries).toEqual([]);
  });

  test("skips malformed per-entry items without crashing the whole parse", async () => {
    const layer = makeGithubModelsCatalogRepositoryLive({
      fetchImpl: makeFetchMock({
        response: jsonResponse([
          "not-an-object",
          null,
          42,
          {},
          { id: 123 },
          { id: "   " },
          { id: "valid/model" },
        ]),
      }),
    });
    const entries = await runEffect(layer)(
      GithubModelsCatalogRepository.pipe(
        Effect.flatMap((repository) => repository.fetchCatalog(Redacted.make("ghp_token"))),
      ),
    );
    expect(entries).toEqual([
      {
        id: "valid/model",
        name: "valid/model",
        capabilities: [],
        supportedInputModalities: [],
        supportedOutputModalities: [],
        maxInputTokens: 8_000,
        maxOutputTokens: 2_000,
        rateLimitTier: "unknown",
      },
    ]);
  });

  test("applies documented defaults when optional fields are missing or invalid", async () => {
    const layer = makeGithubModelsCatalogRepositoryLive({
      fetchImpl: makeFetchMock({
        response: jsonResponse([
          {
            id: "bare/model",
            capabilities: "not-an-array",
            supported_input_modalities: null,
            supported_output_modalities: 7,
            limits: { max_input_tokens: "128000", max_output_tokens: Number.POSITIVE_INFINITY },
            rate_limit_tier: "garbage-tier",
          },
        ]),
      }),
    });
    const entries = await runEffect(layer)(
      GithubModelsCatalogRepository.pipe(
        Effect.flatMap((repository) => repository.fetchCatalog(Redacted.make("ghp_token"))),
      ),
    );
    expect(entries).toEqual([
      {
        id: "bare/model",
        name: "bare/model",
        capabilities: [],
        supportedInputModalities: [],
        supportedOutputModalities: [],
        maxInputTokens: 8_000,
        maxOutputTokens: 2_000,
        rateLimitTier: "unknown",
      },
    ]);
  });

  test("defaults rateLimitTier to unknown when rate_limit_tier is absent", async () => {
    const layer = makeGithubModelsCatalogRepositoryLive({
      fetchImpl: makeFetchMock({
        response: jsonResponse([{ id: "no-tier/model" }]),
      }),
    });
    const entries = await runEffect(layer)(
      GithubModelsCatalogRepository.pipe(
        Effect.flatMap((repository) => repository.fetchCatalog(Redacted.make("ghp_token"))),
      ),
    );
    expect(entries).toEqual([
      {
        id: "no-tier/model",
        name: "no-tier/model",
        capabilities: [],
        supportedInputModalities: [],
        supportedOutputModalities: [],
        maxInputTokens: 8_000,
        maxOutputTokens: 2_000,
        rateLimitTier: "unknown",
      },
    ]);
  });

  test("filters non-string entries out of capabilities and modality arrays", async () => {
    const layer = makeGithubModelsCatalogRepositoryLive({
      fetchImpl: makeFetchMock({
        response: jsonResponse([
          {
            id: "mixed/model",
            capabilities: ["tool-calling", 42, null, "vision"],
            supported_input_modalities: ["text", false],
            supported_output_modalities: [true, "text"],
          },
        ]),
      }),
    });
    const entries = await runEffect(layer)(
      GithubModelsCatalogRepository.pipe(
        Effect.flatMap((repository) => repository.fetchCatalog(Redacted.make("ghp_token"))),
      ),
    );
    expect(entries).toEqual([
      {
        id: "mixed/model",
        name: "mixed/model",
        capabilities: ["tool-calling", "vision"],
        supportedInputModalities: ["text"],
        supportedOutputModalities: ["text"],
        maxInputTokens: 8_000,
        maxOutputTokens: 2_000,
        rateLimitTier: "unknown",
      },
    ]);
  });

  test("resolves to an empty catalog on non-2xx HTTP responses, even with a well-formed body", async () => {
    for (const status of [401, 500]) {
      const layer = makeGithubModelsCatalogRepositoryLive({
        fetchImpl: makeFetchMock({
          // A parseable, non-empty array body proves the empty result comes from the
          // `response.ok` check, not from the body being unparsable.
          response: jsonResponse([{ id: "would-be/valid-model" }], status),
        }),
      });
      const entries = await runEffect(layer)(
        GithubModelsCatalogRepository.pipe(
          Effect.flatMap((repository) => repository.fetchCatalog(Redacted.make("ghp_token"))),
        ),
      );
      expect(entries).toEqual([]);
    }
  });

  test("resolves to an empty catalog when the fetch promise rejects (network error)", async () => {
    const layer = makeGithubModelsCatalogRepositoryLive({
      fetchImpl: makeFetchMock({ reject: new TypeError("network error: connection refused") }),
    });
    const entries = await runEffect(layer)(
      GithubModelsCatalogRepository.pipe(
        Effect.flatMap((repository) => repository.fetchCatalog(Redacted.make("ghp_token"))),
      ),
    );
    expect(entries).toEqual([]);
  });

  test("resolves to an empty catalog when response.json() rejects (invalid JSON)", async () => {
    const badJsonResponse = new Response("not json{{{", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const layer = makeGithubModelsCatalogRepositoryLive({
      fetchImpl: makeFetchMock({ response: badJsonResponse }),
    });
    const entries = await runEffect(layer)(
      GithubModelsCatalogRepository.pipe(
        Effect.flatMap((repository) => repository.fetchCatalog(Redacted.make("ghp_token"))),
      ),
    );
    expect(entries).toEqual([]);
  });

  test("sends the redacted token only as a Bearer authorization header, never in the URL or errors", async () => {
    const secretToken = "ghp_super_secret_value_do_not_leak";
    const captured: { request?: CapturedRequest } = {};
    const layer = makeGithubModelsCatalogRepositoryLive({
      fetchImpl: makeFetchMock({ response: jsonResponse([]), captured }),
    });

    const entries = await runEffect(layer)(
      GithubModelsCatalogRepository.pipe(
        Effect.flatMap((repository) => repository.fetchCatalog(Redacted.make(secretToken))),
      ),
    );

    expect(entries).toEqual([]);
    expect(captured.request).toBeDefined();
    expect(captured.request?.headers.authorization).toBe(`Bearer ${secretToken}`);
    expect(captured.request?.url).not.toContain(secretToken);
    expect(captured.request?.url).toBe("https://models.github.ai/catalog/models");
  });
});
