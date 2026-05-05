import { describe, expect, test } from "bun:test";
import { Duration, Effect, Fiber, Redacted } from "effect";
import { TestClock } from "effect/testing";
import {
  GithubModelsCatalogRepository,
  makeGithubModelsCatalogRepositoryLive,
} from "#auto-pr/live/github-models-catalog-repository.js";

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
});
