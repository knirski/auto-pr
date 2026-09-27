import { describe, expect, test } from "bun:test";
import { Redacted } from "effect";
import {
  aiProviderConfigFromGeneratePrContentConfig,
  aiProviderConfigFromRunAutoPrConfig,
} from "#auto-pr";

describe("AI provider config adapters", () => {
  test("maps local GeneratePrContentConfig to local AiProviderConfig", () => {
    const apiKey = Redacted.make("sk-test", { label: "AUTO_PR_AI_OPENAI_COMPAT_API_KEY" });
    const config = aiProviderConfigFromGeneratePrContentConfig({
      provider: "local",
      workspace: "/workspace",
      templatePath: "/workspace/.github/PULL_REQUEST_TEMPLATE.md",
      defaultBranch: "main",
      branch: "ai/example",
      model: "gpt-oss",
      openaiCompatUrl: "http://127.0.0.1:8080/v1",
      openaiCompatApiKey: apiKey,
    });

    expect(config).toEqual({
      provider: "local",
      model: "gpt-oss",
      openaiCompatUrl: "http://127.0.0.1:8080/v1",
      openaiCompatApiKey: apiKey,
    });
  });

  test("maps openrouter GeneratePrContentConfig to openrouter AiProviderConfig", () => {
    const apiKey = Redacted.make("sk-or-test", { label: "OPENROUTER_API_KEY" });
    const config = aiProviderConfigFromGeneratePrContentConfig({
      provider: "openrouter",
      workspace: "/workspace",
      templatePath: "/workspace/.github/PULL_REQUEST_TEMPLATE.md",
      defaultBranch: "main",
      branch: "ai/example",
      model: "openai/gpt-oss-20b:free",
      openRouterApiKey: apiKey,
      openRouterTitle: "auto-pr",
      openRouterHttpReferer: "https://github.com/knirski/auto-pr",
    });

    expect(config).toEqual({
      provider: "openrouter",
      model: "openai/gpt-oss-20b:free",
      apiKey,
      httpReferer: "https://github.com/knirski/auto-pr",
      title: "auto-pr",
    });
  });

  test("maps openrouter GeneratePrContentConfig without optional referer", () => {
    const apiKey = Redacted.make("sk-or-test", { label: "OPENROUTER_API_KEY" });
    const config = aiProviderConfigFromGeneratePrContentConfig({
      provider: "openrouter",
      workspace: "/workspace",
      templatePath: "/workspace/.github/PULL_REQUEST_TEMPLATE.md",
      defaultBranch: "main",
      branch: "ai/example",
      model: "openai/gpt-oss-20b:free",
      openRouterApiKey: apiKey,
      openRouterTitle: "auto-pr",
    });

    expect(config).toEqual({
      provider: "openrouter",
      model: "openai/gpt-oss-20b:free",
      apiKey,
      title: "auto-pr",
    });
  });

  test("maps local RunAutoPrConfig without optional API key", () => {
    const ghToken = Redacted.make("ghp_test", { label: "GH_TOKEN" });
    const config = aiProviderConfigFromRunAutoPrConfig({
      provider: "local",
      defaultBranch: "main",
      workspace: "/workspace",
      templatePath: "/workspace/.github/PULL_REQUEST_TEMPLATE.md",
      model: "gpt-oss",
      ghToken,
      openaiCompatUrl: "http://127.0.0.1:8080/v1",
    });

    expect(config).toEqual({
      provider: "local",
      model: "gpt-oss",
      openaiCompatUrl: "http://127.0.0.1:8080/v1",
    });
  });

  test("maps openrouter RunAutoPrConfig", () => {
    const ghToken = Redacted.make("ghp_test", { label: "GH_TOKEN" });
    const openRouterApiKey = Redacted.make("sk-or-test", { label: "OPENROUTER_API_KEY" });
    const config = aiProviderConfigFromRunAutoPrConfig({
      provider: "openrouter",
      defaultBranch: "main",
      workspace: "/workspace",
      templatePath: "/workspace/.github/PULL_REQUEST_TEMPLATE.md",
      model: "openai/gpt-oss-20b:free",
      ghToken,
      openRouterApiKey,
      openRouterTitle: "auto-pr",
    });

    expect(config).toEqual({
      provider: "openrouter",
      model: "openai/gpt-oss-20b:free",
      apiKey: openRouterApiKey,
      title: "auto-pr",
    });
  });
});
