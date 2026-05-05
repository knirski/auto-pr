import { describe, expect, test } from "bun:test";
import {
	type GithubModelCatalogEntry,
	pickGithubModelCatalogEntry,
} from "../../src/core/github-model-routing.js";

function entry(input: {
	id: string;
	tier: GithubModelCatalogEntry["rateLimitTier"];
	tool?: boolean;
}): GithubModelCatalogEntry {
	return {
		id: input.id,
		name: input.id,
		capabilities: input.tool === true ? ["tool-calling"] : ["streaming"],
		supportedInputModalities: ["text"],
		supportedOutputModalities: ["text"],
		maxInputTokens: 8_000,
		maxOutputTokens: 2_000,
		rateLimitTier: input.tier,
	};
}

describe("github model catalog fallback strategy", () => {
	test("keeps preferred model when it satisfies requirements", () => {
		const selected = pickGithubModelCatalogEntry({
			selectedModel: "openai/gpt-4.1",
			requiresToolCalls: true,
			entries: [entry({ id: "openai/gpt-4.1", tier: "high", tool: true })],
		});
		expect(selected).toMatchObject({
			model: "openai/gpt-4.1",
			requiresToolCalls: true,
			selectionMode: "preferred",
		});
	});

	test("falls back to same-tier model with tool support first", () => {
		const selected = pickGithubModelCatalogEntry({
			selectedModel: "publisher/preferred-no-tools",
			requiresToolCalls: true,
			entries: [
				entry({ id: "publisher/preferred-no-tools", tier: "high", tool: false }),
				entry({ id: "publisher/same-tier-tools", tier: "high", tool: true }),
				entry({ id: "publisher/other-tier-tools", tier: "low", tool: true }),
			],
		});
		expect(selected).toMatchObject({
			model: "publisher/same-tier-tools",
			requiresToolCalls: true,
			selectionMode: "same-tier-tool-fallback",
		});
	});

	test("degrades to more generous tier with tool support when same-tier is exhausted", () => {
		const selected = pickGithubModelCatalogEntry({
			selectedModel: "publisher/preferred-no-tools",
			requiresToolCalls: true,
			entries: [
				entry({ id: "publisher/preferred-no-tools", tier: "high", tool: false }),
				entry({ id: "publisher/low-tier-tools", tier: "low", tool: true }),
			],
		});
		expect(selected).toMatchObject({
			model: "publisher/low-tier-tools",
			requiresToolCalls: true,
			selectionMode: "cross-tier-tool-fallback",
		});
	});

	test("sacrifices tools only after tool-capable fallbacks are exhausted", () => {
		const selected = pickGithubModelCatalogEntry({
			selectedModel: "publisher/preferred-no-tools",
			requiresToolCalls: true,
			entries: [
				entry({ id: "publisher/preferred-no-tools", tier: "high", tool: false }),
				entry({ id: "publisher/low-tier-no-tools", tier: "low", tool: false }),
			],
		});
		expect(selected).toMatchObject({
			model: "publisher/preferred-no-tools",
			requiresToolCalls: false,
			selectionMode: "same-tier-no-tool-fallback",
		});
	});
});
