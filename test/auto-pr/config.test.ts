import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Cause, ConfigProvider, Effect, Exit, Layer, Redacted, Result } from "effect";
import {
  AutoPrConfigError,
  CreateOrUpdatePrConfig,
  CreateOrUpdatePrConfigLayer,
  DEFAULT_OPENAI_COMPAT_MODEL,
  DEFAULT_OPENAI_COMPAT_URL,
  GeneratePrContentConfig,
  GeneratePrContentConfigLayer,
  ModelRoutingOutputError,
  RunAutoPrConfig,
  RunAutoPrConfigLayer,
} from "#auto-pr";
import { runEffect } from "#test/run-effect.js";
import { createTestTempDirEffect, TestBaseLayer } from "#test/test-utils.js";

/** Empty config provider so required env vars are missing. */
const EmptyConfigProviderLayer = ConfigProvider.layer(ConfigProvider.fromUnknown({}));

function expectConfigFailure<A>(
  effect: Effect.Effect<A, unknown, A>,
  configLayer: Layer.Layer<A, unknown, never>,
): Effect.Effect<void> {
  return effect
    .pipe(Effect.provide(configLayer), Effect.provide(EmptyConfigProviderLayer), Effect.exit)
    .pipe(Effect.flatMap((exit) => Effect.sync(() => expect(Exit.isFailure(exit)).toBe(true))));
}

const GeneratePrContentConfigProviderLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    GITHUB_WORKSPACE: "/workspace",
    DEFAULT_BRANCH: "main",
    BRANCH: "ai/feature",
    AUTO_PR_LOCAL_MODEL: "llama3.1:8b",
  }),
);

const GeneratePrContentLayer = Layer.mergeAll(
  TestBaseLayer,
  GeneratePrContentConfigLayer.pipe(Layer.provide(GeneratePrContentConfigProviderLayer)),
);

describe("GeneratePrContentConfigLayer succeeds when all vars present", () => {
  test("returns config with non-empty values", async () => {
    await runEffect(GeneratePrContentLayer)(
      Effect.gen(function* () {
        const config = yield* GeneratePrContentConfig;
        expect(config.templatePath).toBe(join("/workspace", ".github/PULL_REQUEST_TEMPLATE.md"));
        expect(config.provider).toBe("local");
        expect(config.model).toBe("llama3.1:8b");
        expect(config.existingPrTitle).toBeUndefined();
      }),
    );
  });

  test("trims required string values", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        GITHUB_WORKSPACE: " /workspace ",
        DEFAULT_BRANCH: " main ",
        BRANCH: " ai/feature ",
        AUTO_PR_LOCAL_MODEL: " llama3.1:8b ",
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const config = yield* GeneratePrContentConfig;
        expect(config.workspace).toBe("/workspace");
        expect(config.defaultBranch).toBe("main");
        expect(config.branch).toBe("ai/feature");
        expect(config.model).toBe("llama3.1:8b");
        expect(config.templatePath).toBe(join("/workspace", ".github/PULL_REQUEST_TEMPLATE.md"));
      }),
    );
  });

  test("trims AUTO_PR_EXISTING_PR_TITLE when present", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        GITHUB_WORKSPACE: "/workspace",
        DEFAULT_BRANCH: "main",
        BRANCH: "ai/feature",
        AUTO_PR_LOCAL_MODEL: "llama3.1:8b",
        AUTO_PR_EXISTING_PR_TITLE: "  feat: existing title  ",
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const config = yield* GeneratePrContentConfig;
        expect(config.existingPrTitle).toBe("feat: existing title");
      }),
    );
  });

  test("ignores blank AUTO_PR_EXISTING_PR_TITLE", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        GITHUB_WORKSPACE: "/workspace",
        DEFAULT_BRANCH: "main",
        BRANCH: "ai/feature",
        AUTO_PR_LOCAL_MODEL: "llama3.1:8b",
        AUTO_PR_EXISTING_PR_TITLE: " \t ",
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const config = yield* GeneratePrContentConfig;
        expect(config.existingPrTitle).toBeUndefined();
      }),
    );
  });

  test("trims optional GITHUB_API_URL and GH_HOST", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        GITHUB_WORKSPACE: "/workspace",
        DEFAULT_BRANCH: "main",
        BRANCH: "ai/feature",
        AUTO_PR_LOCAL_MODEL: "llama3.1:8b",
        GITHUB_API_URL: " https://api.github.com/ ",
        GH_HOST: " github.com ",
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const config = yield* GeneratePrContentConfig;
        expect(config.githubApiUrl).toBe("https://api.github.com/");
        expect(config.ghHost).toBe("github.com");
      }),
    );
  });
});

const generatePrContentBaseEnv = {
  GITHUB_WORKSPACE: "/workspace",
  DEFAULT_BRANCH: "main",
  BRANCH: "ai/feature",
};

const openRouterRoutingDecisionJson =
  '{"provider":"openrouter","selectedModel":"openai/gpt-oss-20b:free","requiresToolCalls":true,"tokenBudget":9000,"toolRoundLimit":4,"toolResponseCharBudget":1500}';

async function readGeneratePrContentConfigFailure(
  providerLayer: Layer.Layer<never>,
): Promise<Exit.Exit<GeneratePrContentConfig, AutoPrConfigError | ModelRoutingOutputError>> {
  const layer = Layer.mergeAll(
    TestBaseLayer,
    GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* GeneratePrContentConfig;
    })
      .pipe(Effect.provide(layer))
      .pipe(Effect.exit),
  );
}

describe("GeneratePrContentConfigLayer for openrouter", () => {
  test("uses routing decision, key, model, and attribution config", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...generatePrContentBaseEnv,
        AUTO_PR_AI_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "sk-or-test",
        AUTO_PR_OPENROUTER_MODEL: " openai/gpt-oss-20b:free ",
        AUTO_PR_OPENROUTER_HTTP_REFERER: " https://github.com/knirski/auto-pr ",
        AUTO_PR_OPENROUTER_TITLE: " auto-pr tests ",
        AUTO_PR_ROUTING_DECISION_JSON: openRouterRoutingDecisionJson,
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const config = yield* GeneratePrContentConfig;
        expect(config.provider).toBe("openrouter");
        if (config.provider !== "openrouter") return expect().fail("expected openrouter");
        expect(config.model).toBe("openai/gpt-oss-20b:free");
        expect(config.openRouterModel).toBe("openai/gpt-oss-20b:free");
        expect(config.openRouterHttpReferer).toBe("https://github.com/knirski/auto-pr");
        expect(config.openRouterTitle).toBe("auto-pr tests");
        expect(Redacted.isRedacted(config.openRouterApiKey)).toBe(true);
        expect(config.requiresToolCalls).toBe(true);
        expect(config.aiTokenBudget).toBe(9000);
        expect(config.aiToolRoundLimit).toBe(4);
        expect(config.aiToolResponseCharBudget).toBe(1500);
      }),
    );
  });

  test("uses routing decision as model when AUTO_PR_OPENROUTER_MODEL is unset", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...generatePrContentBaseEnv,
        AUTO_PR_AI_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "sk-or-test",
        AUTO_PR_ROUTING_DECISION_JSON: openRouterRoutingDecisionJson,
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const config = yield* GeneratePrContentConfig;
        if (config.provider !== "openrouter") return expect().fail("expected openrouter");
        expect(config.model).toBe("openai/gpt-oss-20b:free");
        expect(config.openRouterModel).toBeUndefined();
        expect(config.openRouterHttpReferer).toBeUndefined();
        expect(config.openRouterTitle).toBe("auto-pr");
      }),
    );
  });

  test("defaults blank attribution title to auto-pr", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...generatePrContentBaseEnv,
        AUTO_PR_AI_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "sk-or-test",
        AUTO_PR_OPENROUTER_TITLE: "   ",
        AUTO_PR_ROUTING_DECISION_JSON: openRouterRoutingDecisionJson,
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const config = yield* GeneratePrContentConfig;
        if (config.provider !== "openrouter") return expect().fail("expected openrouter");
        expect(config.openRouterTitle).toBe("auto-pr");
      }),
    );
  });

  test("fails when OPENROUTER_API_KEY is missing", async () => {
    const exit = await readGeneratePrContentConfigFailure(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ...generatePrContentBaseEnv,
          AUTO_PR_AI_PROVIDER: "openrouter",
          AUTO_PR_ROUTING_DECISION_JSON: openRouterRoutingDecisionJson,
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      Result.match(Cause.findError(exit.cause), {
        onSuccess: (err) => {
          expect(err).toBeInstanceOf(AutoPrConfigError);
          expect((err as AutoPrConfigError).missing.join(" ")).toContain("OPENROUTER_API_KEY");
        },
        onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
      });
    }
  });

  test("fails when AUTO_PR_ROUTING_DECISION_JSON is missing", async () => {
    const exit = await readGeneratePrContentConfigFailure(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ...generatePrContentBaseEnv,
          AUTO_PR_AI_PROVIDER: "openrouter",
          OPENROUTER_API_KEY: "sk-or-test",
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      Result.match(Cause.findError(exit.cause), {
        onSuccess: (err) => {
          expect(err).toBeInstanceOf(ModelRoutingOutputError);
          expect((err as ModelRoutingOutputError).message).toContain(
            "AUTO_PR_ROUTING_DECISION_JSON",
          );
        },
        onFailure: () => expect().fail("expected ModelRoutingOutputError in cause"),
      });
    }
  });

  test("fails when AUTO_PR_OPENROUTER_MODEL is not a free model", async () => {
    const exit = await readGeneratePrContentConfigFailure(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ...generatePrContentBaseEnv,
          AUTO_PR_AI_PROVIDER: "openrouter",
          OPENROUTER_API_KEY: "sk-or-test",
          AUTO_PR_OPENROUTER_MODEL: "openai/gpt-5.2",
          AUTO_PR_ROUTING_DECISION_JSON: openRouterRoutingDecisionJson,
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      Result.match(Cause.findError(exit.cause), {
        onSuccess: (err) => {
          expect(err).toBeInstanceOf(AutoPrConfigError);
          expect((err as AutoPrConfigError).missing.join(" ")).toContain(
            "AUTO_PR_OPENROUTER_MODEL",
          );
          expect((err as AutoPrConfigError).missing.join(" ")).toContain(":free");
        },
        onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
      });
    }
  });

  test("fails when attribution header values contain CR or LF", async () => {
    const cases = [
      {
        name: "AUTO_PR_OPENROUTER_HTTP_REFERER",
        env: { AUTO_PR_OPENROUTER_HTTP_REFERER: "https://example.com/\r\nInjected: 1" },
      },
      {
        name: "AUTO_PR_OPENROUTER_TITLE",
        env: { AUTO_PR_OPENROUTER_TITLE: "auto-pr\nInjected: 1" },
      },
    ] as const;

    for (const testCase of cases) {
      const exit = await readGeneratePrContentConfigFailure(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            ...generatePrContentBaseEnv,
            AUTO_PR_AI_PROVIDER: "openrouter",
            OPENROUTER_API_KEY: "sk-or-test",
            AUTO_PR_ROUTING_DECISION_JSON: openRouterRoutingDecisionJson,
            ...testCase.env,
          }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        Result.match(Cause.findError(exit.cause), {
          onSuccess: (err) => {
            expect(err).toBeInstanceOf(AutoPrConfigError);
            const missing = (err as AutoPrConfigError).missing.join(" ");
            expect(missing).toContain(testCase.name);
            expect(missing).toContain("must not contain CR or LF");
          },
          onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
        });
      }
    }
  });
});

describe("GeneratePrContentConfigLayer rejects the retired GitHub Models provider", () => {
  test("rejects github-models with a migration message", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...generatePrContentBaseEnv,
        AUTO_PR_AI_PROVIDER: "github-models",
      }),
    );

    const exit = await readGeneratePrContentConfigFailure(providerLayer);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      Result.match(Cause.findError(exit.cause), {
        onSuccess: (err) =>
          expect(String((err as AutoPrConfigError).missing.join(" "))).toContain(
            "GitHub Models was retired on 2026-07-30; use openrouter or local",
          ),
        onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
      });
    }
  });
});

describe("GeneratePrContentConfigLayer for local", () => {
  test("succeeds with all AUTO_PR_AI_OPENAI_COMPAT_* vars", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...generatePrContentBaseEnv,
        AUTO_PR_AI_PROVIDER: "local",
        AUTO_PR_AI_OPENAI_COMPAT_URL: "https://api.openrouter.ai/v1",
        AUTO_PR_AI_OPENAI_COMPAT_API_KEY: "sk-or-test",
        AUTO_PR_LOCAL_MODEL: "meta-llama/llama-3.1-8b-instruct",
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const config = yield* GeneratePrContentConfig;
        expect(config.provider).toBe("local");
        if (config.provider !== "local") return expect().fail("expected local");
        expect(config.model).toBe("meta-llama/llama-3.1-8b-instruct");
        expect(config.openaiCompatUrl).toBe("https://api.openrouter.ai/v1");
        expect(Redacted.isRedacted(config.openaiCompatApiKey)).toBe(true);
      }),
    );
  });

  test("uses default AUTO_PR_AI_OPENAI_COMPAT_URL when omitted", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...generatePrContentBaseEnv,
        AUTO_PR_AI_PROVIDER: "local",
        AUTO_PR_AI_OPENAI_COMPAT_API_KEY: "sk-test",
        AUTO_PR_LOCAL_MODEL: "gpt-4",
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const config = yield* GeneratePrContentConfig;
        expect(config.provider).toBe("local");
        if (config.provider !== "local") return expect().fail("expected local");
        expect(config.openaiCompatUrl).toBe(DEFAULT_OPENAI_COMPAT_URL);
      }),
    );
  });
});

describe("CreateOrUpdatePrConfigLayer succeeds when all vars present", () => {
  test("returns config with ghToken redacted", async () => {
    await runEffect(TestBaseLayer)(
      Effect.gen(function* () {
        const tmp = yield* createTestTempDirEffect("cou-pr-");
        yield* tmp.writeFile(join(tmp.path, "pr-title.txt"), "feat: add x\n");
        const providerLayer = ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            BRANCH: "ai/feature",
            DEFAULT_BRANCH: "main",
            GITHUB_WORKSPACE: tmp.path,
            GH_TOKEN: "ghp_test_token",
          }),
        );
        const fullLayer = Layer.mergeAll(
          TestBaseLayer,
          CreateOrUpdatePrConfigLayer.pipe(Layer.provide(providerLayer)),
        );
        return yield* Effect.gen(function* () {
          const config = yield* CreateOrUpdatePrConfig;
          expect(config.branch).toBe("ai/feature");
          expect(config.title).toBe("feat: add x");
          expect(config.bodyFile).toBe(join(tmp.path, "pr-body.md"));
          expect(Redacted.isRedacted(config.ghToken)).toBe(true);
        }).pipe(Effect.provide(fullLayer));
      }).pipe(Effect.scoped),
    );
  });

  test("includes trimmed optional GitHub API host settings", async () => {
    await runEffect(TestBaseLayer)(
      Effect.gen(function* () {
        const tmp = yield* createTestTempDirEffect("cou-pr-api-host-");
        yield* tmp.writeFile(join(tmp.path, "pr-title.txt"), "feat: add x\n");
        const providerLayer = ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            BRANCH: "ai/feature",
            DEFAULT_BRANCH: "main",
            GITHUB_WORKSPACE: tmp.path,
            GH_TOKEN: "ghp_test_token",
            GITHUB_API_URL: " https://api.github.com/ ",
            GH_HOST: " ghe.example.com ",
          }),
        );
        const fullLayer = Layer.mergeAll(
          TestBaseLayer,
          CreateOrUpdatePrConfigLayer.pipe(Layer.provide(providerLayer)),
        );
        return yield* Effect.gen(function* () {
          const config = yield* CreateOrUpdatePrConfig;
          expect(config.githubApiUrl).toBe("https://api.github.com/");
          expect(config.ghHost).toBe("ghe.example.com");
        }).pipe(Effect.provide(fullLayer));
      }).pipe(Effect.scoped),
    );
  });
});

describe("config layers fail when required env vars missing", () => {
  test("GeneratePrContentConfigLayer fails when GITHUB_WORKSPACE missing", async () => {
    await Effect.runPromise(
      expectConfigFailure(
        Effect.gen(function* () {
          return yield* GeneratePrContentConfig;
        }),
        GeneratePrContentConfigLayer,
      ),
    );
  });

  test("CreateOrUpdatePrConfigLayer fails when required vars missing", async () => {
    await Effect.runPromise(
      expectConfigFailure(
        Effect.gen(function* () {
          return yield* CreateOrUpdatePrConfig;
        }),
        CreateOrUpdatePrConfigLayer.pipe(Layer.provideMerge(TestBaseLayer)),
      ),
    );
  });

  test("CreateOrUpdatePrConfigLayer fails when pr-title.txt is missing", async () => {
    await runEffect(TestBaseLayer)(
      Effect.gen(function* () {
        const tmp = yield* createTestTempDirEffect("cou-pr-no-title-");
        const providerLayer = ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            BRANCH: "ai/feature",
            DEFAULT_BRANCH: "main",
            GITHUB_WORKSPACE: tmp.path,
            GH_TOKEN: "ghp_test_token",
          }),
        );
        const fullLayer = Layer.mergeAll(
          TestBaseLayer,
          CreateOrUpdatePrConfigLayer.pipe(Layer.provide(providerLayer)),
        );
        const exit = yield* Effect.gen(function* () {
          return yield* CreateOrUpdatePrConfig;
        })
          .pipe(Effect.provide(fullLayer))
          .pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          Result.match(Cause.findError(exit.cause), {
            onSuccess: (err) => {
              expect(err).toBeInstanceOf(AutoPrConfigError);
              expect((err as AutoPrConfigError).missing.join(" ")).toContain("pr-title.txt");
            },
            onFailure: () => expect().fail("expected AutoPrConfigError"),
          });
        }
      }).pipe(Effect.scoped),
    );
  });

  test("RunAutoPrConfigLayer fails when GH_TOKEN missing", async () => {
    await Effect.runPromise(
      expectConfigFailure(
        Effect.gen(function* () {
          return yield* RunAutoPrConfig;
        }),
        RunAutoPrConfigLayer,
      ),
    );
  });
});

const runAutoPrBaseEnv = {
  DEFAULT_BRANCH: "main",
  GITHUB_WORKSPACE: "/run-auto-pr-ws",
  GH_TOKEN: "ghp_run_auto_pr",
};

describe("RunAutoPrConfigLayer succeeds", () => {
  test("with local provider (default) and model", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...runAutoPrBaseEnv,
        AUTO_PR_LOCAL_MODEL: "gpt-oss",
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      RunAutoPrConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const config = yield* RunAutoPrConfig;
        expect(config.provider).toBe("local");
        if (config.provider === "local") {
          expect(config.model).toBe("gpt-oss");
          expect(config.openaiCompatUrl).toBe(DEFAULT_OPENAI_COMPAT_URL);
        }
        expect(config.branch).toBeUndefined();
        expect(config.existingPrTitle).toBeUndefined();
      }),
    );
  });

  test("trims AUTO_PR_EXISTING_PR_TITLE", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...runAutoPrBaseEnv,
        AUTO_PR_LOCAL_MODEL: "gpt-oss",
        AUTO_PR_EXISTING_PR_TITLE: "  feat: run existing  ",
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      RunAutoPrConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const config = yield* RunAutoPrConfig;
        expect(config.existingPrTitle).toBe("feat: run existing");
      }),
    );
  });

  test("trims optional GITHUB_API_URL and GH_HOST", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...runAutoPrBaseEnv,
        AUTO_PR_LOCAL_MODEL: "gpt-oss",
        GITHUB_API_URL: " https://api.github.com/ ",
        GH_HOST: " ghe.example.com ",
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      RunAutoPrConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const config = yield* RunAutoPrConfig;
        expect(config.githubApiUrl).toBe("https://api.github.com/");
        expect(config.ghHost).toBe("ghe.example.com");
      }),
    );
  });

  test("trims BRANCH when present", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...runAutoPrBaseEnv,
        BRANCH: "  ai/feature  ",
        AUTO_PR_LOCAL_MODEL: "gpt-oss",
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      RunAutoPrConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const config = yield* RunAutoPrConfig;
        expect(config.branch).toBe("ai/feature");
      }),
    );
  });

  test("ignores blank BRANCH", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...runAutoPrBaseEnv,
        BRANCH: " \t ",
        AUTO_PR_LOCAL_MODEL: "gpt-oss",
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      RunAutoPrConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const config = yield* RunAutoPrConfig;
        expect(config.branch).toBeUndefined();
      }),
    );
  });

  test("with openrouter provider, key, attribution, and route-derived limits", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...runAutoPrBaseEnv,
        AUTO_PR_AI_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "sk-or-test",
        AUTO_PR_OPENROUTER_MODEL: "openai/gpt-oss-20b:free",
        AUTO_PR_OPENROUTER_HTTP_REFERER: "https://github.com/knirski/auto-pr",
        AUTO_PR_OPENROUTER_TITLE: "auto-pr",
        AUTO_PR_ROUTING_DECISION_JSON:
          '{"provider":"openrouter","selectedModel":"openai/gpt-oss-20b:free","requiresToolCalls":true,"tokenBudget":9000,"toolRoundLimit":4,"toolResponseCharBudget":1500}',
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      RunAutoPrConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const config = yield* RunAutoPrConfig;
        expect(config.provider).toBe("openrouter");
        if (config.provider !== "openrouter") return expect().fail("expected openrouter");
        expect(config.model).toBe("openai/gpt-oss-20b:free");
        expect(Redacted.isRedacted(config.openRouterApiKey)).toBe(true);
        expect(config.openRouterTitle).toBe("auto-pr");
        expect(config.openRouterHttpReferer).toBe("https://github.com/knirski/auto-pr");
        expect(config.requiresToolCalls).toBe(true);
        expect(config.aiTokenBudget).toBe(9000);
        expect(config.aiToolRoundLimit).toBe(4);
        expect(config.aiToolResponseCharBudget).toBe(1500);
        expect("openaiCompatUrl" in config).toBe(false);
      }),
    );
  });
});

describe("RunAutoPrConfigLayer rejects invalid AUTO_PR_AI_OPENAI_COMPAT_URL", () => {
  test("fails when URL lacks scheme (local provider)", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...runAutoPrBaseEnv,
        AUTO_PR_AI_PROVIDER: "local",
        AUTO_PR_AI_OPENAI_COMPAT_URL: "localhost:8080/v1",
        AUTO_PR_LOCAL_MODEL: "gpt-oss",
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      RunAutoPrConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* RunAutoPrConfig;
      })
        .pipe(Effect.provide(layer))
        .pipe(Effect.exit),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      Result.match(Cause.findError(exit.cause), {
        onSuccess: (err) => {
          expect(err).toBeInstanceOf(AutoPrConfigError);
          expect((err as AutoPrConfigError).missing.join(" ")).toContain(
            "AUTO_PR_AI_OPENAI_COMPAT_URL",
          );
        },
        onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
      });
    }
  });
});

describe("GeneratePrContentConfig reads DEFAULT_BRANCH and BRANCH", () => {
  test("reads DEFAULT_BRANCH and BRANCH from env", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        GITHUB_WORKSPACE: "/tmp/ws",
        AUTO_PR_AI_PROVIDER: "local",
        AUTO_PR_LOCAL_MODEL: "gpt-oss",
        DEFAULT_BRANCH: "main",
        BRANCH: "ai/test-branch",
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const config = yield* GeneratePrContentConfig;
        expect(config.defaultBranch).toBe("main");
        expect(config.branch).toBe("ai/test-branch");
      }),
    );
  });
});

describe("GeneratePrContentConfigLayer rejects invalid provider", () => {
  test("fails when AUTO_PR_AI_PROVIDER is not local or openrouter", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        GITHUB_WORKSPACE: "/workspace",
        DEFAULT_BRANCH: "main",
        BRANCH: "ai/feature",
        AUTO_PR_AI_PROVIDER: "ollama",
        AUTO_PR_LOCAL_MODEL: "m",
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* GeneratePrContentConfig;
      })
        .pipe(Effect.provide(layer))
        .pipe(Effect.exit),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      Result.match(Cause.findError(exit.cause), {
        onSuccess: (err) => {
          expect(err).toBeInstanceOf(AutoPrConfigError);
          expect((err as AutoPrConfigError).missing.join(" ")).toContain(
            "Invalid AUTO_PR_AI_PROVIDER",
          );
        },
        onFailure: () => expect().fail("expected AutoPrConfigError"),
      });
    }
  });
});

describe("GeneratePrContentConfigLayer rejects branch === defaultBranch", () => {
  test("fails when BRANCH equals DEFAULT_BRANCH", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        GITHUB_WORKSPACE: "/workspace",
        DEFAULT_BRANCH: "main",
        BRANCH: "main",
        AUTO_PR_LOCAL_MODEL: "gpt-oss",
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* GeneratePrContentConfig;
      })
        .pipe(Effect.provide(layer))
        .pipe(Effect.exit),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      Result.match(Cause.findError(exit.cause), {
        onSuccess: (err) => {
          expect(err).toBeInstanceOf(AutoPrConfigError);
          expect((err as AutoPrConfigError).missing.join(" ")).toContain("BRANCH");
          expect((err as AutoPrConfigError).missing.join(" ")).toContain("DEFAULT_BRANCH");
        },
        onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
      });
    }
  });

  test("fails when trimmed BRANCH equals trimmed DEFAULT_BRANCH", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        GITHUB_WORKSPACE: "/workspace",
        DEFAULT_BRANCH: " main ",
        BRANCH: " main ",
        AUTO_PR_LOCAL_MODEL: "gpt-oss",
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* GeneratePrContentConfig;
      })
        .pipe(Effect.provide(layer))
        .pipe(Effect.exit),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      Result.match(Cause.findError(exit.cause), {
        onSuccess: (err) => {
          expect(err).toBeInstanceOf(AutoPrConfigError);
          expect((err as AutoPrConfigError).missing.join(" ")).toContain("BRANCH");
          expect((err as AutoPrConfigError).missing.join(" ")).toContain("DEFAULT_BRANCH");
        },
        onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
      });
    }
  });
});

describe("RunAutoPrConfigLayer rejects branch === defaultBranch when BRANCH is set", () => {
  test("fails when BRANCH equals DEFAULT_BRANCH", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...runAutoPrBaseEnv,
        BRANCH: "main",
        AUTO_PR_LOCAL_MODEL: "gpt-oss",
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      RunAutoPrConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* RunAutoPrConfig;
      })
        .pipe(Effect.provide(layer))
        .pipe(Effect.exit),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      Result.match(Cause.findError(exit.cause), {
        onSuccess: (err) => {
          expect(err).toBeInstanceOf(AutoPrConfigError);
          expect((err as AutoPrConfigError).missing.join(" ")).toContain("BRANCH");
        },
        onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
      });
    }
  });

  test("succeeds when BRANCH is not set (optional in RunAutoPr)", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...runAutoPrBaseEnv,
        AUTO_PR_LOCAL_MODEL: "gpt-oss",
        // No BRANCH set
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      RunAutoPrConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const config = yield* RunAutoPrConfig;
        expect(config.branch).toBeUndefined();
      }),
    );
  });
});

describe("GeneratePrContentConfigLayer uses default values and logs warnings", () => {
  test("fails when AUTO_PR_AI_OPENAI_COMPAT_URL lacks scheme (local provider)", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...generatePrContentBaseEnv,
        AUTO_PR_AI_PROVIDER: "local",
        AUTO_PR_AI_OPENAI_COMPAT_URL: "localhost:8080/v1",
        AUTO_PR_LOCAL_MODEL: "gpt-oss",
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* GeneratePrContentConfig;
      }).pipe(Effect.provide(layer), Effect.exit),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      Result.match(Cause.findError(exit.cause), {
        onSuccess: (err) => {
          expect(err).toBeInstanceOf(AutoPrConfigError);
          expect((err as AutoPrConfigError).missing.join(" ")).toContain(
            "AUTO_PR_AI_OPENAI_COMPAT_URL",
          );
        },
        onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
      });
    }
  });

  test("uses default AUTO_PR_AI_OPENAI_COMPAT_URL when not set (local provider)", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...generatePrContentBaseEnv,
        AUTO_PR_AI_PROVIDER: "local",
        AUTO_PR_LOCAL_MODEL: "gpt-oss",
        // No AUTO_PR_AI_OPENAI_COMPAT_URL
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const config = yield* GeneratePrContentConfig;
        expect(config.provider).toBe("local");
        if (config.provider !== "local") return expect().fail("expected local");
        expect(config.openaiCompatUrl).toBe(DEFAULT_OPENAI_COMPAT_URL);
        expect(config.model).toBe("gpt-oss");
      }),
    );
  });

  test("uses default AUTO_PR_LOCAL_MODEL when not set (local provider)", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...generatePrContentBaseEnv,
        AUTO_PR_AI_PROVIDER: "local",
        AUTO_PR_AI_OPENAI_COMPAT_URL: "http://localhost:8080/v1",
        // No AUTO_PR_LOCAL_MODEL
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const config = yield* GeneratePrContentConfig;
        expect(config.provider).toBe("local");
        if (config.provider !== "local") return expect().fail("expected local");
        expect(config.model).toBe(DEFAULT_OPENAI_COMPAT_MODEL);
        expect(config.openaiCompatUrl).toBe("http://localhost:8080/v1");
      }),
    );
  });

  test("fails when openrouter and AUTO_PR_ROUTING_DECISION_JSON is not set", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...generatePrContentBaseEnv,
        AUTO_PR_AI_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "sk-or-test",
        // No AUTO_PR_ROUTING_DECISION_JSON
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* GeneratePrContentConfig;
      })
        .pipe(Effect.provide(layer))
        .pipe(Effect.exit),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      Result.match(Cause.findError(exit.cause), {
        onSuccess: (err) => {
          expect(err).toBeInstanceOf(ModelRoutingOutputError);
          expect((err as ModelRoutingOutputError).message).toContain(
            "AUTO_PR_ROUTING_DECISION_JSON",
          );
        },
        onFailure: () => expect().fail("expected ModelRoutingOutputError in cause"),
      });
    }
  });
});
