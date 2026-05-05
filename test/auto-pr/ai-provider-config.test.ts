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

  test("maps github-models GeneratePrContentConfig to github-models AiProviderConfig", () => {
    const ghToken = Redacted.make("ghp_test", { label: "GH_TOKEN" });
    const config = aiProviderConfigFromGeneratePrContentConfig({
      provider: "github-models",
      workspace: "/workspace",
      templatePath: "/workspace/.github/PULL_REQUEST_TEMPLATE.md",
      defaultBranch: "main",
      branch: "ai/example",
      model: "openai/gpt-4.1",
      ghToken,
    });

    expect(config).toEqual({
      provider: "github-models",
      model: "openai/gpt-4.1",
      ghToken,
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

  test("maps github-models RunAutoPrConfig", () => {
    const ghToken = Redacted.make("ghp_test", { label: "GH_TOKEN" });
    const config = aiProviderConfigFromRunAutoPrConfig({
      provider: "github-models",
      defaultBranch: "main",
      workspace: "/workspace",
      templatePath: "/workspace/.github/PULL_REQUEST_TEMPLATE.md",
      model: "openai/gpt-4.1",
      ghToken,
    });

    expect(config).toEqual({
      provider: "github-models",
      model: "openai/gpt-4.1",
      ghToken,
    });
  });
});
