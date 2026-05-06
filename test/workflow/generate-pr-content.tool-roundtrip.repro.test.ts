import { describe, expect, test } from "bun:test";
import { Duration, Effect, Layer, Redacted } from "effect";
import { aiProviderLayerFromConfig, DiffToolkit, GitContext } from "#auto-pr";
import { runEffect } from "#test/run-effect.js";
import { createGitContextMock, TestBaseLayer } from "#test/test-utils.js";
import { generatePrContent } from "#workflow/auto-pr-generate-content.js";

type ToolRoundtripReproFetchOptions = {
  readonly passThroughRequestObject?: boolean;
  readonly firstAssistantContent?: string | null;
};

function createToolRoundtripReproFetch(options?: ToolRoundtripReproFetchOptions): {
  readonly fetch: typeof fetch;
  readonly getInvalidRequest: () => string | undefined;
} {
  let callCount = 0;
  let invalidRequest: string | undefined;
  const requiredToolCallIds: ReadonlyArray<string> = ["call_ci", "call_docs"];
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    callCount += 1;
    const request =
      options?.passThroughRequestObject === true && input instanceof Request ? input : undefined;
    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : init?.body != null
          ? await new Request("http://local.invalid", {
              method: "POST",
              body: init.body as BodyInit,
            }).text()
          : ((await request?.clone().text()) ?? "");

    if (callCount === 1) {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 0,
          model: "mock",
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: options?.firstAssistantContent ?? null,
                tool_calls: [
                  {
                    id: "call_ci",
                    type: "function",
                    function: {
                      name: "get_diff",
                      arguments: '{"path":".github/workflows/ci.yml"}',
                    },
                  },
                  {
                    id: "call_docs",
                    type: "function",
                    function: {
                      name: "get_diff",
                      arguments: '{"path":"docs/CI.md"}',
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      );
    }

    /*
     * The second request is the actual repro assertion.
     *
     * The first mocked response above returns one assistant message containing
     * two parallel tool calls. generatePrContent executes both get_diff calls
     * through DiffToolkit and then asks the model for the next round. At that
     * point the outgoing OpenAI-compatible request must contain the assistant
     * tool-call turn followed immediately by both tool result messages.
     *
     * GitHub Models rejects requests where the history has been expanded into:
     *
     *   assistant tool_calls: [call_ci]
     *   assistant tool_calls: [call_docs]
     *   tool call_ci
     *   tool call_docs
     *
     * because the first assistant tool_call is followed by another assistant
     * message instead of its tool result. This mock enforces the provider-side
     * rule instead of checking for a particular internal Effect representation:
     * find the assistant message that contains the required tool calls, then
     * require the following messages to be the matching tool results.
     */
    const body = JSON.parse(bodyText) as {
      readonly messages?: ReadonlyArray<{
        readonly role?: string;
        readonly content?: unknown;
        readonly tool_call_id?: string;
        readonly tool_calls?: ReadonlyArray<{ readonly id?: string }>;
      }>;
    };

    const toolCallingMessageIndex = body.messages?.findIndex((message) =>
      message.tool_calls?.some((toolCall) => requiredToolCallIds.includes(toolCall.id ?? "")),
    );

    if (toolCallingMessageIndex === undefined || toolCallingMessageIndex < 0) {
      invalidRequest ??= `missing assistant tool_calls on request #${callCount}\n${JSON.stringify(body, null, 2)}`;
      throw new Error(invalidRequest);
    }

    const immediateToolMessages = body.messages?.slice(
      toolCallingMessageIndex + 1,
      toolCallingMessageIndex + 1 + requiredToolCallIds.length,
    );

    const returnedToolCallIds = new Set(
      immediateToolMessages
        ?.filter((message) => message.role === "tool")
        .map((message) => message.tool_call_id),
    );

    const missingToolCallIds = requiredToolCallIds.filter((id) => !returnedToolCallIds.has(id));

    if (missingToolCallIds.length > 0) {
      invalidRequest ??= `missing immediate tool results on request #${callCount}: ${missingToolCallIds.join(", ")}\n${JSON.stringify(body, null, 2)}`;
      throw new Error(invalidRequest);
    }

    return new Response(
      JSON.stringify({
        id: "chatcmpl-2",
        object: "chat.completion",
        created: 0,
        model: "mock",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content:
                '{"title":"feat: ok","motivation":["m"],"benefits":["b"],"risks":["r"],"notesForReviewers":"n"}',
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200 },
    );
  };

  return {
    fetch: Object.assign(impl, {
      preconnect: globalThis.fetch.preconnect.bind(globalThis.fetch),
    }),
    getInvalidRequest: () => invalidRequest,
  };
}

const ReproGitLayer = Layer.succeed(
  GitContext,
  createGitContextMock({
    getCurrentBranch: () => Effect.succeed("ai/repro"),
    getLog: () =>
      Effect.succeed(
        [
          "---COMMIT---",
          "1111111111111111111111111111111111111111",
          "feat: add x",
          "---COMMIT---",
          "2222222222222222222222222222222222222222",
          "fix: handle y",
        ].join("\n"),
      ),
    getChangedFiles: () => Effect.succeed("src/a.ts\n"),
    getDiffStat: () => Effect.succeed(" src/a.ts | 1 +\n 1 file changed, 1 insertion(+)"),
    getDiff: () => Effect.succeed("diff --git a/src/a.ts b/src/a.ts\n"),
    getCommitDiff: () => Effect.succeed(""),
  }),
);

const ReproDiffToolkitLayer = DiffToolkit.toLayer(
  Effect.succeed(
    DiffToolkit.of({
      get_diff: () => Effect.succeed("diff --git a/src/a.ts b/src/a.ts\n"),
      get_commit_diff: () => Effect.succeed(""),
    }),
  ),
);

describe("generatePrContent tool-call roundtrip repro", () => {
  test("replays every parallel tool result into the second OpenAI-compatible request", async () => {
    /*
     * This is the minimal end-to-end reproduction for the production failure:
     * generatePrContent receives a tool_calls finish reason, runs two tools,
     * and sends a second chat-completions request. Without the fetch-level
     * normalization, the current adapter can split the two tool calls into
     * adjacent assistant messages, which makes this mock throw the same class
     * of invalid-request error that GitHub Models returned in CI.
     */
    const mock = createToolRoundtripReproFetch();
    const layer = Layer.mergeAll(
      TestBaseLayer,
      ReproGitLayer,
      ReproDiffToolkitLayer,
      aiProviderLayerFromConfig(
        {
          provider: "github-models",
          model: "openai/gpt-4.1",
          ghToken: Redacted.make("mock-github-token"),
        },
        { fetch: mock.fetch },
      ),
    );

    await runEffect(layer)(
      Effect.gen(function* () {
        const result = yield* generatePrContent({
          baseRef: "origin/main",
          headRef: "ai/repro",
          templateContent: "# PR\n\n{{description}}",
          descriptionPromptText: "Return JSON only.",
          provider: "github-models",
          model: "openai/gpt-4.1",
          retryDelay: Duration.zero,
        });

        expect(mock.getInvalidRequest()).toBeUndefined();
        expect(result.title).toBe("feat: ok");
      }).pipe(Effect.scoped),
    );
  });

  test("normalizes tool-call history when fetch receives a Request object", async () => {
    /*
     * FetchHttpClient implementations are allowed to pass request data either
     * as fetch(url, init) or as a Request object. The workaround has to read and
     * rewrite both forms; otherwise it would pass unit tests with a simple mock
     * but still fail if the HTTP client constructs Request before calling fetch.
     */
    const mock = createToolRoundtripReproFetch({ passThroughRequestObject: true });
    const fetchViaRequestObject = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request
          ? input
          : new Request(
              input,
              init?.body === undefined ? init : { ...init, body: init.body as BodyInit },
            );
      return mock.fetch(request);
    }) as typeof fetch;
    const layer = Layer.mergeAll(
      TestBaseLayer,
      ReproGitLayer,
      ReproDiffToolkitLayer,
      aiProviderLayerFromConfig(
        {
          provider: "github-models",
          model: "openai/gpt-4.1",
          ghToken: Redacted.make("mock-github-token"),
        },
        {
          fetch: Object.assign(fetchViaRequestObject, {
            preconnect: globalThis.fetch.preconnect.bind(globalThis.fetch),
          }),
        },
      ),
    );

    await runEffect(layer)(
      Effect.gen(function* () {
        const result = yield* generatePrContent({
          baseRef: "origin/main",
          headRef: "ai/repro",
          templateContent: "# PR\n\n{{description}}",
          descriptionPromptText: "Return JSON only.",
          provider: "github-models",
          model: "openai/gpt-4.1",
          retryDelay: Duration.zero,
        });

        expect(mock.getInvalidRequest()).toBeUndefined();
        expect(result.title).toBe("feat: ok");
      }).pipe(Effect.scoped),
    );
  });

  test("preserves valid assistant text before split tool-call messages", async () => {
    /*
     * Some model responses include assistant text before tool calls. Effect can
     * serialize that text as a separate assistant message before the tool-call
     * assistant message:
     *
     *   assistant content: "Looking at CI..."
     *   assistant tool_calls: [...]
     *   tool ...
     *
     * That sequence is valid and should not be flattened indiscriminately. The
     * workaround is intentionally narrower: it only coalesces adjacent assistant
     * messages that themselves carry tool_calls, preserving ordinary assistant
     * text history around them.
     */
    const mock = createToolRoundtripReproFetch({
      firstAssistantContent: "Looking at CI.\nLooking at docs.",
    });
    const layer = Layer.mergeAll(
      TestBaseLayer,
      ReproGitLayer,
      ReproDiffToolkitLayer,
      aiProviderLayerFromConfig(
        {
          provider: "github-models",
          model: "openai/gpt-4.1",
          ghToken: Redacted.make("mock-github-token"),
        },
        {
          fetch: mock.fetch,
        },
      ),
    );

    await runEffect(layer)(
      Effect.gen(function* () {
        const result = yield* generatePrContent({
          baseRef: "origin/main",
          headRef: "ai/repro",
          templateContent: "# PR\n\n{{description}}",
          descriptionPromptText: "Return JSON only.",
          provider: "github-models",
          model: "openai/gpt-4.1",
          retryDelay: Duration.zero,
        });

        expect(mock.getInvalidRequest()).toBeUndefined();
        expect(result.title).toBe("feat: ok");
      }).pipe(Effect.scoped),
    );
  });
});
