/**
 * Pure model-band routing policy for auto-pr.
 */

import { isBlank } from "#core/string.js";

export type ModelProvider = "local" | "github-models";

export type ModelBand = "A" | "B" | "C";

export type ToolStrategy = "none" | "hotspot" | "full-diff" | "commit-diff";

export type ReasoningNeed = "low" | "medium" | "high";

export type ModelBandSignals = {
	readonly semanticCommitCount: number;
	readonly conventionalTypeCount: number;
	readonly topLevelSpread: number;
	readonly changedFileCount: number;
	readonly sourceFileCount: number;
	readonly docsFileCount: number;
	readonly testFileCount: number;
	readonly generatedFileCount: number;
	readonly lockfileCount: number;
	readonly packageManifestCount: number;
	readonly rawChurn: number;
	readonly sourceChurn: number;
	readonly generatedChurn: number;
	readonly hasBreakingChange: boolean;
	readonly hasBinaryFiles: boolean;
};

export type ModelBandDecision = {
	readonly band: ModelBand;
	readonly selectedModel: string;
	readonly routingContext: string;
	readonly toolStrategy: ToolStrategy;
	readonly reasoningNeed: ReasoningNeed;
	readonly requiresToolCalls: boolean;
};

export type ResolveModelBandInput = {
	readonly provider: ModelProvider;
	readonly explicitModel?: string;
	readonly signals: ModelBandSignals;
};

function toBucket(
	value: number,
	thresholds: readonly [number, number],
	labels: readonly [string, string, string],
): string {
	if (value >= thresholds[1]) return labels[2];
	if (value >= thresholds[0]) return labels[1];
	return labels[0];
}

function safeRatio(numerator: number, denominator: number): number {
	if (denominator <= 0) return 0;
	return Math.floor((numerator * 100) / denominator);
}

function hasDocsAndSource(signals: ModelBandSignals): boolean {
	return signals.docsFileCount > 0 && signals.sourceFileCount > 0;
}

function hasTestsAndSource(signals: ModelBandSignals): boolean {
	return signals.testFileCount > 0 && signals.sourceFileCount > 0;
}

function isDocsOnly(signals: ModelBandSignals): boolean {
	return (
		signals.docsFileCount > 0 &&
		signals.sourceFileCount === 0 &&
		signals.testFileCount === 0 &&
		signals.generatedFileCount === 0
	);
}

function isGeneratedOnly(signals: ModelBandSignals): boolean {
	return (
		signals.generatedFileCount > 0 &&
		signals.sourceFileCount === 0 &&
		signals.docsFileCount === 0 &&
		signals.testFileCount === 0
	);
}

function isTinyAndFocused(signals: ModelBandSignals): boolean {
	return (
		signals.semanticCommitCount <= 2 &&
		signals.changedFileCount <= 3 &&
		signals.topLevelSpread <= 1 &&
		signals.sourceChurn < 200 &&
		signals.conventionalTypeCount <= 2
	);
}

function isBroadChange(signals: ModelBandSignals): boolean {
	return (
		signals.hasBreakingChange ||
		signals.sourceChurn >= 1200 ||
		signals.semanticCommitCount >= 8 ||
		signals.conventionalTypeCount >= 3 ||
		signals.topLevelSpread >= 3 ||
		(signals.changedFileCount >= 15 && signals.sourceFileCount >= 4)
	);
}

function isCrossCutting(signals: ModelBandSignals): boolean {
	return (
		hasDocsAndSource(signals) ||
		hasTestsAndSource(signals) ||
		signals.lockfileCount > 0 ||
		signals.packageManifestCount > 0
	);
}

function isGeneratedDominant(signals: ModelBandSignals): boolean {
	return (
		signals.rawChurn > 0 &&
		safeRatio(signals.generatedChurn, signals.rawChurn) >= 80 &&
		signals.sourceChurn < 120
	);
}

export function resolveBand(signals: ModelBandSignals): ModelBand {
	if (
		isGeneratedDominant(signals) ||
		isTinyAndFocused(signals) ||
		isDocsOnly(signals) ||
		isGeneratedOnly(signals)
	) {
		return "A";
	}

	if (isBroadChange(signals) || (isCrossCutting(signals) && signals.sourceChurn >= 400)) {
		return "C";
	}

	return "B";
}

export function selectModel(
	provider: ModelProvider,
	band: ModelBand,
	explicitModel?: string,
	routing?: {
		readonly requiresToolCalls?: boolean;
		readonly reasoningNeed?: ReasoningNeed;
	},
): string {
	const override = explicitModel?.trim() ?? "";
	if (!isBlank(override)) return override;
	if (provider === "github-models") {
		return band === "C" || routing?.requiresToolCalls === true || routing?.reasoningNeed === "high"
			? "openai/gpt-4.1"
			: "microsoft/phi-4-mini-instruct";
	}
	return "gpt-oss";
}

export function resolveReasoningNeed(signals: ModelBandSignals, band: ModelBand): ReasoningNeed {
	if (
		band === "C" ||
		signals.hasBreakingChange ||
		signals.sourceChurn >= 1200 ||
		signals.topLevelSpread >= 4
	) {
		return "high";
	}
	if (band === "B") return "medium";
	return "low";
}

export function resolveToolStrategy(signals: ModelBandSignals, band: ModelBand): ToolStrategy {
	if (band === "A" && !signals.hasBreakingChange) return "none";
	if (
		band === "C" ||
		signals.hasBreakingChange ||
		signals.sourceChurn >= 1200 ||
		signals.topLevelSpread >= 4 ||
		(signals.changedFileCount >= 15 && signals.sourceFileCount >= 4)
	) {
		return "full-diff";
	}
	if (signals.semanticCommitCount >= 4 && signals.conventionalTypeCount >= 2) {
		return "commit-diff";
	}
	if (
		signals.sourceFileCount > 0 ||
		signals.testFileCount > 0 ||
		signals.packageManifestCount > 0 ||
		signals.lockfileCount > 0
	) {
		return "hotspot";
	}
	return "none";
}

function summarizeFlags(signals: ModelBandSignals): string[] {
	const flags: string[] = [];
	if (signals.hasBreakingChange) flags.push("breaking");
	if (signals.hasBinaryFiles) flags.push("binary");
	if (hasDocsAndSource(signals)) flags.push("docs+src");
	if (hasTestsAndSource(signals)) flags.push("tests+src");
	if (signals.lockfileCount > 0) flags.push("lockfiles");
	if (signals.packageManifestCount > 0) flags.push("package-manifests");
	return flags;
}

function summarizeSignalContext(input: {
	readonly band: ModelBand;
	readonly signals: ModelBandSignals;
	readonly generatedRatio: number;
	readonly hardness: string;
}): string {
	const { signals, band, generatedRatio, hardness } = input;
	const scope = isDocsOnly(signals)
		? "docs-only"
		: isGeneratedOnly(signals)
			? "generated-only"
			: signals.sourceFileCount > 0 &&
					signals.docsFileCount === 0 &&
					signals.testFileCount === 0 &&
					signals.generatedFileCount === 0
				? "source-only"
				: signals.testFileCount > 0 &&
						signals.sourceFileCount === 0 &&
						signals.docsFileCount === 0 &&
						signals.generatedFileCount === 0
					? "test-only"
					: hasDocsAndSource(signals)
						? "docs+source"
						: hasTestsAndSource(signals)
							? "tests+source"
							: signals.lockfileCount > 0 || signals.packageManifestCount > 0
								? "dependency/config"
								: "mixed";
	const flags = summarizeFlags(signals);
	const details = [
		scope,
		`${signals.semanticCommitCount} commit${signals.semanticCommitCount === 1 ? "" : "s"}`,
		`${signals.changedFileCount} file${signals.changedFileCount === 1 ? "" : "s"}`,
		`${signals.sourceChurn} source churn`,
		`${generatedRatio}% generated churn`,
		`band=${band}`,
		`hardness=${hardness}`,
	];
	if (flags.length > 0) {
		details.push(`signals=${flags.join(",")}`);
	}
	return details.join(", ");
}

export function buildRoutingContext(input: {
	readonly band: ModelBand;
	readonly signals: ModelBandSignals;
}): string {
	const { signals, band } = input;
	const generatedRatio = safeRatio(signals.generatedChurn, signals.rawChurn);
	const srcBucket = toBucket(signals.sourceChurn, [350, 1200], ["small", "medium", "large"]);
	const rawBucket = toBucket(signals.rawChurn, [250, 1200], ["small", "medium", "large"]);
	const filesBucket = toBucket(signals.changedFileCount, [4, 12], ["small", "medium", "large"]);
	const spreadBucket = toBucket(signals.topLevelSpread, [2, 4], ["narrow", "medium", "wide"]);
	const hardness =
		band === "C"
			? "high"
			: band === "A"
				? "low"
				: signals.conventionalTypeCount >= 2 ||
						signals.topLevelSpread >= 2 ||
						signals.sourceChurn >= 400
					? "medium"
					: "low";
	const flags = summarizeFlags(signals);
	const summary = summarizeSignalContext({ band, signals, generatedRatio, hardness });
	const parts = [
		`summary=${summary}`,
		`band=${band}`,
		`commits=${signals.semanticCommitCount}`,
		`types=${signals.conventionalTypeCount}`,
		`files=${filesBucket}`,
		`spread=${spreadBucket}`,
		`src=${srcBucket}`,
		`raw=${rawBucket}`,
		`generated_ratio=${generatedRatio}`,
		`source_files=${signals.sourceFileCount}`,
		`docs_files=${signals.docsFileCount}`,
		`test_files=${signals.testFileCount}`,
		`generated_files=${signals.generatedFileCount}`,
		`lockfiles=${signals.lockfileCount}`,
		`packages=${signals.packageManifestCount}`,
		`hardness=${hardness}`,
	];
	if (flags.length > 0) {
		parts.push(`signals=${flags.join(",")}`);
	}
	return `${parts.join("; ")}. Prefer user-visible and breaking changes over lockfiles/generated churn.`;
}

export function resolveModelBand(input: ResolveModelBandInput): ModelBandDecision {
	const band = resolveBand(input.signals);
	const reasoningNeed = resolveReasoningNeed(input.signals, band);
	const toolStrategy = resolveToolStrategy(input.signals, band);
	const requiresToolCalls = toolStrategy !== "none";
	const selectedModel = selectModel(input.provider, band, input.explicitModel, {
		reasoningNeed,
		requiresToolCalls,
	});
	const routingContext = buildRoutingContext({ band, signals: input.signals });
	return {
		band,
		selectedModel,
		routingContext,
		toolStrategy,
		reasoningNeed,
		requiresToolCalls,
	};
}
