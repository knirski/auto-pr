import { Match } from "effect";
import type { GeneratePrContentConfig, RunAutoPrConfig } from "#auto-pr/config.js";
import type { AiProviderConfig } from "#auto-pr/live/ai-provider.js";

type ConfigWithAiProvider = GeneratePrContentConfig | RunAutoPrConfig;

export function aiProviderConfigFromGeneratePrContentConfig(
  config: GeneratePrContentConfig,
): AiProviderConfig {
  return aiProviderConfigFromConfig(config);
}

export function aiProviderConfigFromRunAutoPrConfig(config: RunAutoPrConfig): AiProviderConfig {
  return aiProviderConfigFromConfig(config);
}

function aiProviderConfigFromConfig(config: ConfigWithAiProvider): AiProviderConfig {
  return Match.value(config).pipe(
    Match.when(
      { provider: "local" },
      (local): AiProviderConfig => ({
        provider: "local",
        model: local.model,
        openaiCompatUrl: local.openaiCompatUrl,
        ...(local.openaiCompatApiKey !== undefined
          ? { openaiCompatApiKey: local.openaiCompatApiKey }
          : {}),
      }),
    ),
    Match.when(
      { provider: "openrouter" },
      (openRouter): AiProviderConfig => ({
        provider: "openrouter",
        model: openRouter.model,
        apiKey: openRouter.openRouterApiKey,
        ...(openRouter.openRouterHttpReferer !== undefined
          ? { httpReferer: openRouter.openRouterHttpReferer }
          : {}),
        title: openRouter.openRouterTitle,
      }),
    ),
    Match.exhaustive,
  );
}
