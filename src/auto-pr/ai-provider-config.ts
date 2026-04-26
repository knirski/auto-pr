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
	switch (config.provider) {
		case "local":
			return {
				provider: "local",
				model: config.model,
				openaiCompatUrl: config.openaiCompatUrl,
				...(config.openaiCompatApiKey !== undefined
					? { openaiCompatApiKey: config.openaiCompatApiKey }
					: {}),
			};
		case "github-models":
			return {
				provider: "github-models",
				model: config.model,
				ghToken: config.ghToken,
			};
	}
}
