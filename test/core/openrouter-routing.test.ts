import { describe, expect, test } from "bun:test";
import { Result } from "effect";
import type { ModelBand } from "#core/model-routing.js";
import {
  buildOpenRouterRequestEnvelope,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_OPENROUTER_TITLE,
  hasOnlyKnownZeroPrices,
  isOpenRouterFreeModel,
  isOpenRouterModelExpired,
  modelSupportsTextOutput,
  modelSupportsToolCalls,
  normalizeOpenRouterPricing,
  OPENROUTER_API_URL,
  OPENROUTER_FREE_MODEL_PREFERENCES,
  type OpenRouterModelCatalogEntry,
  type OpenRouterModelPricing,
  type OpenRouterRouteClass,
  parseOpenRouterModelCatalog,
  parseOpenRouterPrice,
  pickOpenRouterModelCatalogEntry,
  type RequestedEnvelopeInput,
  resolveOpenRouterRouteClass,
  validateOpenRouterModelId,
} from "#core/openrouter-routing.js";

// Wire-shape fixtures mirroring GET https://openrouter.ai/api/v1/models.
const toolFreeModel = {
  id: "openai/gpt-oss-20b:free",
  name: "GPT OSS 20B",
  context_length: 131_072,
  expiration_date: null,
  pricing: {
    prompt: "0",
    completion: "0",
    request: "0",
    image: "0",
    web_search: "0",
    internal_reasoning: "0",
    input_cache_read: "0",
    input_cache_write: "0",
    overrides: [],
  },
  architecture: {
    input_modalities: ["text"],
    output_modalities: ["text"],
  },
  supported_parameters: ["tools", "tool_choice", "max_tokens"],
};

const textFreeModel = {
  id: "google/gemma-4-31b-it:free",
  name: "Gemma 4 31B",
  context_length: 262_144,
  expiration_date: null,
  pricing: {
    prompt: "0",
    completion: "0",
    request: "0",
    image: "0",
    web_search: "0",
    internal_reasoning: "0",
    input_cache_read: "0",
    input_cache_write: "0",
    overrides: [],
  },
  architecture: {
    input_modalities: ["text"],
    output_modalities: ["text"],
  },
  supported_parameters: ["max_tokens"],
};

function freePricing(patch: Partial<OpenRouterModelPricing> = {}): OpenRouterModelPricing {
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
    ...patch,
  };
}

function freeEntry(input: {
  readonly id: string;
  readonly contextLength?: number;
  readonly supportedParameters?: readonly string[];
  readonly inputModalities?: readonly string[];
  readonly outputModalities?: readonly string[];
  readonly expirationDate?: string;
  readonly pricing?: OpenRouterModelPricing;
}): OpenRouterModelCatalogEntry {
  return {
    id: input.id,
    name: input.id,
    contextLength: input.contextLength ?? 131_072,
    supportedParameters: input.supportedParameters ?? ["tools", "tool_choice", "max_tokens"],
    inputModalities: input.inputModalities ?? ["text"],
    outputModalities: input.outputModalities ?? ["text"],
    ...(input.expirationDate === undefined ? {} : { expirationDate: input.expirationDate }),
    pricing: input.pricing ?? freePricing(),
  };
}

function requestedEnvelopeInput(
  patch: Partial<RequestedEnvelopeInput> = {},
): RequestedEnvelopeInput {
  return {
    promptChars: 20_000,
    commitCount: 3,
    changedFileCount: 5,
    sourceChurn: 300,
    toolStrategy: "hotspot",
    reasoningNeed: "medium",
    ...patch,
  };
}

describe("OpenRouter constants", () => {
  test("exposes the API URL, default model, and default title", () => {
    expect(OPENROUTER_API_URL).toBe("https://openrouter.ai/api/v1");
    expect(DEFAULT_OPENROUTER_MODEL).toBe("openai/gpt-oss-20b:free");
    expect(DEFAULT_OPENROUTER_TITLE).toBe("auto-pr");
  });

  test("route preferences keep free tool-capable defaults per route class", () => {
    expect(OPENROUTER_FREE_MODEL_PREFERENCES["B-tool-medium"]).toContain("openai/gpt-oss-20b:free");
    expect(OPENROUTER_FREE_MODEL_PREFERENCES["C-tool-strong"]).toContain("openai/gpt-oss-20b:free");
  });
});

describe("parseOpenRouterPrice", () => {
  test("parses numeric strings and numbers", () => {
    expect(parseOpenRouterPrice("0")).toBe(0);
    expect(parseOpenRouterPrice("0.000001")).toBe(0.000001);
    expect(parseOpenRouterPrice(1.5)).toBe(1.5);
  });

  test("treats missing and malformed values as unknown", () => {
    expect(parseOpenRouterPrice(undefined)).toBeUndefined();
    expect(parseOpenRouterPrice(null)).toBeUndefined();
    expect(parseOpenRouterPrice("")).toBeUndefined();
    expect(parseOpenRouterPrice("   ")).toBeUndefined();
    expect(parseOpenRouterPrice("abc")).toBeUndefined();
    expect(parseOpenRouterPrice(Number.NaN)).toBeUndefined();
  });
});

describe("normalizeOpenRouterPricing", () => {
  test("maps documented wire keys to camelCase and keeps missing values unknown", () => {
    const pricing = normalizeOpenRouterPricing({
      prompt: "0",
      completion: "0.5",
      image_output: "1",
      input_cache_write_1h: "2",
    });
    expect(pricing.prompt).toBe(0);
    expect(pricing.completion).toBe(0.5);
    expect(pricing.imageOutput).toBe(1);
    expect(pricing.inputCacheWrite1h).toBe(2);
    expect(pricing.request).toBeUndefined();
    expect(pricing.unknownPriceKeys).toEqual([]);
  });

  test("preserves unknown pricing keys so free selection can reject them", () => {
    const pricing = normalizeOpenRouterPricing({ prompt: "0", mystery_fee: "0" });
    expect(pricing.unknownPriceKeys).toEqual(["mystery_fee"]);
    expect(hasOnlyKnownZeroPrices(pricing)).toBe(false);
  });

  test("records conditional override prices and condition keys", () => {
    const pricing = normalizeOpenRouterPricing({
      prompt: "0",
      completion: "0",
      overrides: [{ min_prompt_tokens: 128_000, prompt: "0.000001" }],
    });
    expect(pricing.overrides).toHaveLength(1);
    expect(pricing.overrides[0]?.conditionKeys).toEqual(["min_prompt_tokens"]);
    expect(pricing.overrides[0]?.prices.prompt).toBe(0.000001);
  });

  test("tolerates missing or non-object pricing input", () => {
    expect(normalizeOpenRouterPricing(undefined).prompt).toBeUndefined();
    expect(normalizeOpenRouterPricing("nope").unknownPriceKeys).toEqual([]);
    expect(normalizeOpenRouterPricing({ overrides: "nope" }).overrides).toEqual([]);
  });
});

describe("parseOpenRouterModelCatalog", () => {
  test("keeps valid free models and skips malformed entries", () => {
    const parsed = parseOpenRouterModelCatalog({
      data: [
        toolFreeModel,
        textFreeModel,
        { id: "", pricing: { prompt: "0", completion: "0" } },
        { name: "missing id" },
      ],
    });

    expect(parsed.map((entry) => entry.id)).toEqual([
      "openai/gpt-oss-20b:free",
      "google/gemma-4-31b-it:free",
    ]);
    expect(parsed[0]?.contextLength).toBe(131_072);
    expect(parsed[0]?.expirationDate).toBeUndefined();
    expect(parsed[0]?.pricing.prompt).toBe(0);
    expect(parsed[0]?.pricing.completion).toBe(0);
    expect(parsed[0]?.pricing.request).toBe(0);
  });

  test("accepts a direct array and ignores non-catalog input", () => {
    expect(parseOpenRouterModelCatalog([toolFreeModel])).toHaveLength(1);
    expect(parseOpenRouterModelCatalog({ data: "nope" })).toEqual([]);
    expect(parseOpenRouterModelCatalog(null)).toEqual([]);
  });

  test("trims ids and names, defaults missing context length, and keeps unknown prices", () => {
    const parsed = parseOpenRouterModelCatalog([
      {
        id: "  vendor/model:free  ",
        name: "  Vendor Model  ",
        pricing: { prompt: "0" },
        architecture: { output_modalities: ["TEXT"] },
        supported_parameters: ["Tools"],
      },
    ]);
    const entry = parsed[0];
    expect(entry?.id).toBe("vendor/model:free");
    expect(entry?.name).toBe("Vendor Model");
    expect(entry?.contextLength).toBe(8_000);
    expect(entry?.pricing.completion).toBeUndefined();
    expect(entry?.outputModalities).toEqual(["TEXT"]);
    expect(entry?.supportedParameters).toEqual(["Tools"]);
  });

  test("rejects entries whose non-empty price parses to a non-finite number", () => {
    const parsed = parseOpenRouterModelCatalog([
      { id: "broken:free", pricing: { prompt: "abc" } },
      { id: "object:free", pricing: { prompt: { nested: true } } },
      { id: "ok:free", pricing: { prompt: "0", completion: "0" } },
    ]);
    expect(parsed.map((entry) => entry.id)).toEqual(["ok:free"]);
  });

  test("parses string context lengths and falls back for invalid ones", () => {
    const parsed = parseOpenRouterModelCatalog([
      { id: "string-ctx:free", context_length: "32768", pricing: { prompt: "0" } },
      { id: "bad-ctx:free", context_length: "abc", pricing: { prompt: "0" } },
    ]);
    expect(parsed[0]?.contextLength).toBe(32_768);
    expect(parsed[1]?.contextLength).toBe(8_000);
  });

  test("keeps malformed expiration dates and treats them as infeasible", () => {
    const parsed = parseOpenRouterModelCatalog([
      {
        id: "soon:free",
        expiration_date: "not-a-date",
        pricing: { prompt: "0", completion: "0" },
      },
    ]);
    const entry = parsed[0];
    expect(entry?.expirationDate).toBe("not-a-date");
    expect(isOpenRouterModelExpired(entry?.expirationDate)).toBe(true);
    if (entry !== undefined) expect(isOpenRouterFreeModel(entry)).toBe(false);
  });
});

describe("validateOpenRouterModelId", () => {
  test("accepts :free model ids and the free router, trimming the result", () => {
    const free = validateOpenRouterModelId("  openai/gpt-oss-20b:free  ");
    expect(Result.isSuccess(free)).toBe(true);
    if (Result.isSuccess(free)) expect(free.success).toBe("openai/gpt-oss-20b:free");
    expect(Result.isSuccess(validateOpenRouterModelId("openrouter/free"))).toBe(true);
  });

  test("rejects paid and blank model ids with a reason", () => {
    const paid = validateOpenRouterModelId("openai/gpt-4.1");
    expect(Result.isFailure(paid)).toBe(true);
    if (Result.isFailure(paid)) {
      expect(paid.failure.model).toBe("openai/gpt-4.1");
      expect(paid.failure.reason).toContain("free");
    }
    expect(Result.isFailure(validateOpenRouterModelId(""))).toBe(true);
    expect(Result.isFailure(validateOpenRouterModelId("   "))).toBe(true);
  });
});

describe("isOpenRouterModelExpired", () => {
  const now = new Date("2026-09-27T12:00:00Z");

  test("treats a missing date as live and dates before today as expired", () => {
    expect(isOpenRouterModelExpired(undefined, now)).toBe(false);
    expect(isOpenRouterModelExpired("2026-09-28", now)).toBe(false);
    expect(isOpenRouterModelExpired("2026-09-27", now)).toBe(false);
    expect(isOpenRouterModelExpired("2026-09-26", now)).toBe(true);
    expect(isOpenRouterModelExpired("not-a-date", now)).toBe(true);
  });
});

describe("hasOnlyKnownZeroPrices", () => {
  test("accepts models that only advertise zero prices", () => {
    expect(hasOnlyKnownZeroPrices(freePricing())).toBe(true);
    expect(
      hasOnlyKnownZeroPrices(normalizeOpenRouterPricing({ prompt: "0", completion: "0" })),
    ).toBe(true);
  });

  test("rejects unknown price keys", () => {
    expect(hasOnlyKnownZeroPrices(freePricing({ unknownPriceKeys: ["mystery_fee"] }))).toBe(false);
  });

  test("rejects conditional overrides that cannot be proven free", () => {
    const zeroConditionalOverride = normalizeOpenRouterPricing({
      prompt: "0",
      completion: "0",
      overrides: [{ min_prompt_tokens: 128_000, prompt: "0" }],
    });
    expect(hasOnlyKnownZeroPrices(zeroConditionalOverride)).toBe(false);

    const nonZeroOverride = normalizeOpenRouterPricing({
      prompt: "0",
      completion: "0",
      overrides: [{ prompt: "0.001" }],
    });
    expect(hasOnlyKnownZeroPrices(nonZeroOverride)).toBe(false);

    const unknownOverride = normalizeOpenRouterPricing({
      prompt: "0",
      completion: "0",
      overrides: [{ mystery_fee: "0" }],
    });
    expect(hasOnlyKnownZeroPrices(unknownOverride)).toBe(false);

    const zeroOnlyOverride = normalizeOpenRouterPricing({
      prompt: "0",
      completion: "0",
      overrides: [{ prompt: "0" }],
    });
    expect(hasOnlyKnownZeroPrices(zeroOnlyOverride)).toBe(true);
  });
});

describe("isOpenRouterFreeModel", () => {
  test("requires the :free suffix, a live date, and known zero prices", () => {
    expect(isOpenRouterFreeModel(freeEntry({ id: "openai/gpt-oss-20b:free" }))).toBe(true);
    expect(isOpenRouterFreeModel(freeEntry({ id: "openai/gpt-4.1" }))).toBe(false);
    expect(
      isOpenRouterFreeModel(freeEntry({ id: "vendor/model:free", expirationDate: "2020-01-01" })),
    ).toBe(false);
    expect(
      isOpenRouterFreeModel(
        freeEntry({ id: "vendor/model:free", pricing: freePricing({ request: 0.0001 }) }),
      ),
    ).toBe(false);
  });

  test("rejects every present chargeable component that is not zero", () => {
    const nonZeroPatches: ReadonlyArray<readonly [string, Partial<OpenRouterModelPricing>]> = [
      ["prompt", { prompt: 0.000001 }],
      ["completion", { completion: 0.000001 }],
      ["request", { request: 0.000001 }],
      ["image", { image: 0.000001 }],
      ["imageOutput", { imageOutput: 0.000001 }],
      ["imageToken", { imageToken: 0.000001 }],
      ["audio", { audio: 0.000001 }],
      ["audioOutput", { audioOutput: 0.000001 }],
      ["webSearch", { webSearch: 0.000001 }],
      ["internalReasoning", { internalReasoning: 0.000001 }],
      ["inputCacheRead", { inputCacheRead: 0.000001 }],
      ["inputCacheWrite", { inputCacheWrite: 0.000001 }],
      ["inputCacheWrite1h", { inputCacheWrite1h: 0.000001 }],
    ];
    for (const [label, patch] of nonZeroPatches) {
      const entry = freeEntry({ id: "vendor/model:free", pricing: freePricing(patch) });
      expect(isOpenRouterFreeModel(entry), label).toBe(false);
    }
  });
});

describe("model capability checks", () => {
  test("text output requires an advertised text output modality", () => {
    expect(modelSupportsTextOutput(freeEntry({ id: "a:free", outputModalities: ["text"] }))).toBe(
      true,
    );
    expect(modelSupportsTextOutput(freeEntry({ id: "a:free", outputModalities: ["TEXT"] }))).toBe(
      true,
    );
    expect(modelSupportsTextOutput(freeEntry({ id: "a:free", outputModalities: ["image"] }))).toBe(
      false,
    );
  });

  test("tool calls require both tools and tool_choice", () => {
    expect(
      modelSupportsToolCalls(
        freeEntry({ id: "a:free", supportedParameters: ["tools", "tool_choice"] }),
      ),
    ).toBe(true);
    expect(
      modelSupportsToolCalls(
        freeEntry({ id: "a:free", supportedParameters: ["Tools", "TOOL_CHOICE"] }),
      ),
    ).toBe(true);
    expect(
      modelSupportsToolCalls(freeEntry({ id: "a:free", supportedParameters: ["tools"] })),
    ).toBe(false);
    expect(
      modelSupportsToolCalls(freeEntry({ id: "a:free", supportedParameters: ["tool_choice"] })),
    ).toBe(false);
  });
});

describe("resolveOpenRouterRouteClass", () => {
  const cases: ReadonlyArray<readonly [ModelBand, boolean, OpenRouterRouteClass]> = [
    ["A", false, "A-text-light"],
    ["A", true, "A-text-light"],
    ["B", false, "B-text-medium"],
    ["B", true, "B-tool-medium"],
    ["C", false, "C-text-strong"],
    ["C", true, "C-tool-strong"],
  ];

  test.each(cases)(
    "maps band %s with requiresToolCalls=%s to %s",
    (band, requiresToolCalls, expected) => {
      expect(resolveOpenRouterRouteClass({ band, requiresToolCalls })).toBe(expected);
    },
  );
});

describe("pickOpenRouterModelCatalogEntry", () => {
  test("configured free model wins when it is catalog-feasible", () => {
    const selection = pickOpenRouterModelCatalogEntry({
      band: "B",
      configuredModel: "openai/gpt-oss-20b:free",
      requiresToolCalls: true,
      entries: [
        freeEntry({ id: "openai/gpt-oss-20b:free" }),
        freeEntry({ id: "google/gemma-4-26b-a4b-it:free" }),
      ],
    });
    expect(selection).toMatchObject({
      model: "openai/gpt-oss-20b:free",
      requiresToolCalls: true,
      selectionMode: "preferred",
    });
    expect(selection.catalogEntry?.id).toBe("openai/gpt-oss-20b:free");
  });

  test("configured free model is preserved when catalog discovery is unavailable", () => {
    const selection = pickOpenRouterModelCatalogEntry({
      band: "C",
      configuredModel: "openai/gpt-oss-20b:free",
      requiresToolCalls: true,
      entries: [],
    });
    expect(selection).toEqual({
      model: "openai/gpt-oss-20b:free",
      requiresToolCalls: true,
      selectionMode: "configured",
    });
  });

  test("static fallback returns the default free model when the catalog is empty", () => {
    const selection = pickOpenRouterModelCatalogEntry({
      band: "C",
      requiresToolCalls: true,
      entries: [],
    });
    expect(selection).toMatchObject({
      model: DEFAULT_OPENROUTER_MODEL,
      requiresToolCalls: true,
      selectionMode: "static-fallback",
    });
    expect(selection.catalogEntry).toBeUndefined();
  });

  test("route-class preference is selected from the catalog", () => {
    const selection = pickOpenRouterModelCatalogEntry({
      band: "C",
      requiresToolCalls: true,
      entries: [
        freeEntry({ id: "poolside/laguna-s-2.1:free" }),
        freeEntry({ id: "openai/gpt-oss-20b:free" }),
      ],
    });
    expect(selection).toMatchObject({
      model: "openai/gpt-oss-20b:free",
      requiresToolCalls: true,
      selectionMode: "catalog",
    });
  });

  test("configured model missing from the catalog yields to a catalog preference", () => {
    const selection = pickOpenRouterModelCatalogEntry({
      band: "A",
      configuredModel: "vendor/vanished:free",
      requiresToolCalls: false,
      entries: [freeEntry({ id: "openai/gpt-oss-20b:free" })],
    });
    expect(selection).toMatchObject({
      model: "openai/gpt-oss-20b:free",
      selectionMode: "catalog",
    });
  });

  test("tool routes require both tools and tool_choice", () => {
    const selection = pickOpenRouterModelCatalogEntry({
      band: "B",
      requiresToolCalls: true,
      entries: [
        freeEntry({
          id: "vendor/tools-no-tool-choice:free",
          supportedParameters: ["tools", "max_tokens"],
        }),
        freeEntry({
          id: "vendor/tool-choice-no-tools:free",
          supportedParameters: ["tool_choice", "max_tokens"],
        }),
      ],
    });
    expect(selection.selectionMode).toBe("free-text-fallback");
    expect(selection.requiresToolCalls).toBe(false);
  });

  test("tool routes prefer a free tool-capable model over text-only models", () => {
    const selection = pickOpenRouterModelCatalogEntry({
      band: "B",
      requiresToolCalls: true,
      entries: [
        freeEntry({
          id: "poolside/laguna-s-2.1:free",
          supportedParameters: ["max_tokens"],
        }),
        freeEntry({ id: "vendor/tool-model:free" }),
      ],
    });
    expect(selection).toMatchObject({
      model: "vendor/tool-model:free",
      requiresToolCalls: true,
      selectionMode: "free-tool-fallback",
    });
  });

  test("text routes require a text output modality", () => {
    const selection = pickOpenRouterModelCatalogEntry({
      band: "A",
      requiresToolCalls: false,
      entries: [freeEntry({ id: "vendor/image-only:free", outputModalities: ["image"] })],
    });
    expect(selection).toMatchObject({
      model: DEFAULT_OPENROUTER_MODEL,
      requiresToolCalls: false,
      selectionMode: "static-fallback",
    });
  });

  test("free text fallback picks another feasible free model", () => {
    const selection = pickOpenRouterModelCatalogEntry({
      band: "A",
      requiresToolCalls: false,
      entries: [freeEntry({ id: "poolside/laguna-s-2.1:free" })],
    });
    expect(selection).toMatchObject({
      model: "poolside/laguna-s-2.1:free",
      requiresToolCalls: false,
      selectionMode: "free-text-fallback",
    });
  });

  test("expired catalog entries are infeasible", () => {
    const selection = pickOpenRouterModelCatalogEntry({
      band: "B",
      requiresToolCalls: false,
      entries: [
        freeEntry({ id: "openai/gpt-oss-20b:free", expirationDate: "2020-01-01" }),
        freeEntry({ id: "google/gemma-4-26b-a4b-it:free" }),
      ],
    });
    expect(selection).toMatchObject({
      model: "google/gemma-4-26b-a4b-it:free",
      selectionMode: "catalog",
    });
  });

  test("paid and unknown-priced catalog entries are infeasible", () => {
    const selection = pickOpenRouterModelCatalogEntry({
      band: "B",
      requiresToolCalls: false,
      entries: [
        freeEntry({
          id: "openai/gpt-oss-20b:free",
          pricing: freePricing({ completion: 0.000001 }),
        }),
        freeEntry({
          id: "vendor/unknown-price:free",
          pricing: freePricing({ unknownPriceKeys: ["mystery_fee"] }),
        }),
        freeEntry({ id: "google/gemma-4-26b-a4b-it:free" }),
      ],
    });
    expect(selection).toMatchObject({
      model: "google/gemma-4-26b-a4b-it:free",
      selectionMode: "catalog",
    });
  });

  test("configured paid model is ignored by catalog selection", () => {
    const selection = pickOpenRouterModelCatalogEntry({
      band: "B",
      configuredModel: "openai/gpt-4.1",
      requiresToolCalls: false,
      entries: [freeEntry({ id: "google/gemma-4-26b-a4b-it:free" })],
    });
    expect(selection).toMatchObject({
      model: "google/gemma-4-26b-a4b-it:free",
      selectionMode: "catalog",
    });
  });
});

describe("buildOpenRouterRequestEnvelope", () => {
  test("clamps the token budget to the catalog context length", () => {
    const envelope = buildOpenRouterRequestEnvelope({
      model: DEFAULT_OPENROUTER_MODEL,
      source: "catalog",
      requested: requestedEnvelopeInput({
        promptChars: 400_000,
        commitCount: 20,
        changedFileCount: 40,
        sourceChurn: 5_000,
        toolStrategy: "full-diff",
        reasoningNeed: "high",
      }),
      catalogEntry: freeEntry({ id: DEFAULT_OPENROUTER_MODEL, contextLength: 8_000 }),
    });
    expect(envelope.provider).toBe("openrouter");
    expect(envelope.model).toBe(DEFAULT_OPENROUTER_MODEL);
    expect(envelope.contextLength).toBe(8_000);
    expect(envelope.tokenBudget).toBe(8_000);
    expect(envelope.requestedInputTokens).toBeGreaterThan(6_500);
    expect(envelope.requestedOutputTokens).toBeGreaterThanOrEqual(1_000);
    expect(envelope.toolRoundLimit).toBeGreaterThanOrEqual(2);
    expect(envelope.toolRoundLimit).toBeLessThanOrEqual(12);
    expect(envelope.toolResponseCharBudget).toBeGreaterThanOrEqual(1_500);
    expect(envelope.toolResponseCharBudget).toBeLessThanOrEqual(32_000);
  });

  test("defaults context length and keeps the requested source without a catalog entry", () => {
    const envelope = buildOpenRouterRequestEnvelope({
      model: DEFAULT_OPENROUTER_MODEL,
      source: "static-fallback",
      requested: requestedEnvelopeInput(),
    });
    expect(envelope.contextLength).toBe(8_000);
    expect(envelope.source).toBe("static-fallback");
    expect(envelope.tokenBudget).toBeGreaterThanOrEqual(4_000);
    expect(envelope.tokenBudget).toBeLessThanOrEqual(8_000);
  });
});
