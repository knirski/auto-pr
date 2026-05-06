/**
 * AI provider layer factory. Builds Layer<LanguageModel> from config.
 * Providers: `local` (any local LLM via OpenAI-compatible HTTP — e.g. llama.cpp), `github-models`.
 *
 * Both use `@effect/ai-openai-compat` (`OpenAiClient.layer` + `OpenAiLanguageModel.model`) + `FetchHttpClient`.
 * Outgoing HTTP matches the OpenAI Chat Completions API (`POST …/v1/chat/completions`); see
 * https://platform.openai.com/docs/api-reference/chat/create and `@effect/ai-openai-compat`.
 * Generate-content uses `LanguageModel.generateText` + JSON parse (not `generateObject` / `json_schema`); see `auto-pr-generate-content.ts`.
 *
 * ADR: docs/adr/0007-ai-abstraction-layer.md, docs/adr/0009-ollama-to-openai-compat-migration.md
 */

import * as OpenAiClient from "@effect/ai-openai-compat/OpenAiClient";
import * as OpenAiLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel";
import type { Redacted } from "effect";
import { Effect, Layer, Match, Redacted as RedactedValue } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { DEFAULT_OPENAI_COMPAT_URL } from "#auto-pr/config.js";
import { AutoPrConfigError } from "#core/errors.js";

const GITHUB_MODELS_INFERENCE_URL = "https://models.github.ai/inference";

type OpenAiChatMessage = {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly tool_calls?: unknown;
  readonly [key: string]: unknown;
};

type OpenAiChatCompletionsBody = {
  readonly messages?: unknown;
  readonly [key: string]: unknown;
};

type OpenAiAssistantToolCallMessage = OpenAiChatMessage & {
  readonly role: "assistant";
  readonly tool_calls: ReadonlyArray<unknown>;
};

export type AiProviderConfigLocal = {
  readonly provider: "local";
  readonly model: string;
  /** Base URL for OpenAI-compatible `/v1/...`; defaults when omitted for direct tests. */
  readonly openaiCompatUrl?: string;
  readonly openaiCompatApiKey?: Redacted.Redacted<string>;
};

export type AiProviderConfigGithubModels = {
  readonly provider: "github-models";
  readonly model: string;
  readonly ghToken: Redacted.Redacted<string>;
};

/** Config for AI provider layer (provider, model, and provider-specific fields). */
export type AiProviderConfig = AiProviderConfigLocal | AiProviderConfigGithubModels;

function openAiLanguageModelStack(
  clientOptions: OpenAiClient.Options,
  modelId: string,
  fetchOverrideLayer: Layer.Layer<never>,
) {
  const clientLayer = OpenAiClient.layer(clientOptions).pipe(Layer.provide(FetchHttpClient.layer));
  const modelLayer = OpenAiLanguageModel.model(modelId);
  return Layer.mergeAll(fetchOverrideLayer, modelLayer.pipe(Layer.provide(clientLayer)));
}

function redactedHasText(
  value: Redacted.Redacted<string> | undefined,
): value is Redacted.Redacted<string> {
  return value !== undefined && RedactedValue.value(value).trim() !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAssistantToolCallMessage(message: unknown): message is OpenAiAssistantToolCallMessage {
  return (
    isRecord(message) &&
    message.role === "assistant" &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.length > 0
  );
}

function mergeAssistantContent(left: unknown, right: unknown): unknown {
  if (right === undefined || right === null || right === "") {
    return left;
  }
  if (left === undefined || left === null || left === "") {
    return right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return `${left}\n${right}`;
  }
  return left;
}

/**
 * Work around a chat-history serialization shape produced by the current
 * Effect OpenAI-compatible adapter for parallel tool calls.
 *
 * OpenAI-compatible chat completions require this ordering after an assistant
 * tool-call turn:
 *
 *   assistant { tool_calls: [call_a, call_b] }
 *   tool      { tool_call_id: call_a, ... }
 *   tool      { tool_call_id: call_b, ... }
 *
 * The failing GitHub Models requests showed the history being serialized as:
 *
 *   assistant { tool_calls: [call_a] }
 *   assistant { tool_calls: [call_b] }
 *   tool      { tool_call_id: call_a, ... }
 *   tool      { tool_call_id: call_b, ... }
 *
 * That second assistant message interrupts the required "assistant tool_calls
 * immediately followed by matching tool messages" contract, so GitHub Models
 * rejects the next request with:
 *
 *   "An assistant message with 'tool_calls' must be followed by tool messages
 *    responding to each 'tool_call_id'."
 *
 * This function repairs only the narrow invalid shape: consecutive assistant
 * messages that each contain tool_calls are coalesced into one assistant
 * message with the combined tool_calls array. It deliberately does not merge
 * across any non-assistant-tool-call message. In particular, a preceding plain
 * assistant text message is valid OpenAI chat history and must remain separate:
 *
 *   assistant { content: "Looking at the diff..." }
 *   assistant { tool_calls: [...] }
 *   tool      { ... }
 *
 * Keeping this as a fetch-level normalization is a compatibility shim around
 * the external adapter's outgoing JSON. The rest of the application continues
 * to use Effect's LanguageModel abstraction and does not duplicate provider
 * request construction.
 */
function coalesceAdjacentAssistantToolCallMessages(
  body: OpenAiChatCompletionsBody,
): OpenAiChatCompletionsBody {
  if (!Array.isArray(body.messages)) {
    return body;
  }

  let changed = false;
  const messages: Array<unknown> = [];

  for (let index = 0; index < body.messages.length; index += 1) {
    const message = body.messages[index];
    if (!isAssistantToolCallMessage(message)) {
      messages.push(message);
      continue;
    }

    const toolCalls = [...message.tool_calls];
    let content = message.content;
    let nextIndex = index + 1;

    while (
      nextIndex < body.messages.length &&
      isAssistantToolCallMessage(body.messages[nextIndex])
    ) {
      const nextMessage = body.messages[nextIndex];
      toolCalls.push(...nextMessage.tool_calls);
      content = mergeAssistantContent(content, nextMessage.content);
      nextIndex += 1;
      changed = true;
    }

    messages.push({ ...message, content, tool_calls: toolCalls });
    index = nextIndex - 1;
  }

  return changed ? { ...body, messages } : body;
}

async function bodyTextFromRequest(input: RequestInfo | URL, init?: RequestInit) {
  if (init?.body !== undefined && init.body !== null) {
    if (typeof init.body === "string") {
      return init.body;
    }
    return new Request("http://local.invalid", {
      method: "POST",
      body: init.body as BodyInit,
    }).text();
  }

  if (input instanceof Request) {
    return input.clone().text();
  }

  return undefined;
}

function isChatCompletionsPost(input: RequestInfo | URL, init?: RequestInit): boolean {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? (input instanceof Request ? input.method : undefined);
  return String(url).includes("/chat/completions") && method?.toUpperCase() === "POST";
}

function normalizeOpenAiChatCompletionsFetch(baseFetch: typeof fetch): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isChatCompletionsPost(input, init)) {
      return baseFetch(input, init);
    }

    const bodyText = await bodyTextFromRequest(input, init);
    if (bodyText === undefined) {
      return baseFetch(input, init);
    }

    let parsed: OpenAiChatCompletionsBody;
    try {
      parsed = JSON.parse(bodyText) as OpenAiChatCompletionsBody;
    } catch {
      return baseFetch(input, init);
    }
    // Normalize immediately before the HTTP boundary so this applies to both
    // real providers and tests using a mocked fetch, without changing the
    // Effect LanguageModel messages or provider selection logic.
    const normalized = coalesceAdjacentAssistantToolCallMessages(parsed);
    return baseFetch(input, { ...init, body: JSON.stringify(normalized) });
  };
  const preconnectFetch = baseFetch.preconnect !== undefined ? baseFetch : globalThis.fetch;

  return Object.assign(impl, {
    preconnect: (baseFetch.preconnect ?? globalThis.fetch.preconnect).bind(preconnectFetch),
  });
}

/**
 * Build Layer<LanguageModel> from provider config.
 * Supports `local` and `github-models`.
 *
 * Pass `options.fetch` in tests to mock `POST …/chat/completions` (OpenAI-compatible JSON).
 */
export function aiProviderLayerFromConfig(
  config: AiProviderConfig,
  options?: { fetch?: typeof fetch },
): Layer.Layer<LanguageModel.LanguageModel, AutoPrConfigError> {
  const fetchOverrideLayer = Layer.succeed(
    FetchHttpClient.Fetch,
    normalizeOpenAiChatCompletionsFetch(options?.fetch ?? globalThis.fetch),
  );

  return Match.value(config).pipe(
    Match.when({ provider: "local" }, (local) => {
      const apiUrl = local.openaiCompatUrl ?? DEFAULT_OPENAI_COMPAT_URL;
      const apiKey = local.openaiCompatApiKey;
      const clientOptions: OpenAiClient.Options = {
        apiUrl,
        ...(redactedHasText(apiKey) ? { apiKey } : {}),
      };
      return openAiLanguageModelStack(clientOptions, local.model, fetchOverrideLayer);
    }),
    Match.when({ provider: "github-models" }, (githubModels) => {
      if (!redactedHasText(githubModels.ghToken) || githubModels.model.trim() === "") {
        return Layer.effect(
          LanguageModel.LanguageModel,
          Effect.fail(
            new AutoPrConfigError({
              missing: ["GH_TOKEN and resolved model are required for github-models"],
            }),
          ),
        );
      }
      return openAiLanguageModelStack(
        {
          apiUrl: GITHUB_MODELS_INFERENCE_URL,
          apiKey: githubModels.ghToken,
        },
        githubModels.model,
        fetchOverrideLayer,
      );
    }),
    Match.exhaustive,
  );
}
