/**
 * Pure prompt-context builder for model routing.
 */

import { buildRoutingContext, type ModelBand, type ModelBandSignals } from "#core/model-band.js";

export type RoutingContextHotspot = {
	path: string;
	churn: number;
	insertions: number;
	deletions: number;
	kind: string;
};

export type RoutingContextCommitSummary = {
	readonly semanticCommitCount: number;
	readonly mergeCommitCount: number;
	readonly breakingCommitCount: number;
	readonly typeCounts: Readonly<Record<string, number>>;
	readonly subjects: readonly string[];
};

export type RoutingContextFileSummary = {
	readonly topLevelDirs: readonly string[];
	readonly topFiles: readonly RoutingContextHotspot[];
	readonly topDirs: readonly RoutingContextHotspot[];
	readonly sourceFileCount: number;
	readonly docsFileCount: number;
	readonly testFileCount: number;
	readonly generatedFileCount: number;
	readonly lockfileCount: number;
	readonly packageManifestCount: number;
	readonly rawChurn: number;
	readonly sourceChurn: number;
	readonly generatedChurn: number;
	readonly hasBinaryFiles: boolean;
};

export type BuildDetailedRoutingContextInput = {
	readonly band: ModelBand;
	readonly signals: ModelBandSignals;
	readonly commits: RoutingContextCommitSummary;
	readonly files: RoutingContextFileSummary;
};

function formatCountLabel(count: number, singular: string, plural?: string): string {
	return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

function joinList(values: readonly string[]): string {
	return values.length === 0 ? "none" : values.join(", ");
}

function formatTypeCounts(typeCounts: Readonly<Record<string, number>>): string {
	const order = [
		"feat",
		"fix",
		"docs",
		"refactor",
		"test",
		"perf",
		"ci",
		"build",
		"chore",
		"revert",
	];
	const entries = Object.entries(typeCounts).filter(([, count]) => count > 0);
	const sorted = entries.sort(([a], [b]) => {
		const ai = order.indexOf(a);
		const bi = order.indexOf(b);
		if (ai === -1 && bi === -1) return a.localeCompare(b);
		if (ai === -1) return 1;
		if (bi === -1) return -1;
		return ai - bi;
	});
	return sorted.length === 0
		? "none"
		: sorted.map(([type, count]) => `${type}=${count}`).join(", ");
}

function formatHotspots(hotspots: readonly RoutingContextHotspot[]): string {
	if (hotspots.length === 0) return "none";
	return hotspots
		.map((spot) => `${spot.path} (+${spot.insertions}/-${spot.deletions}, ${spot.kind})`)
		.join("; ");
}

function formatPercent(numerator: number, denominator: number): string {
	if (denominator <= 0) return "0%";
	return `${Math.floor((numerator * 100) / denominator)}%`;
}

function summarizeScope(files: RoutingContextFileSummary): string {
	const scope =
		files.docsFileCount > 0 &&
		files.sourceFileCount === 0 &&
		files.testFileCount === 0 &&
		files.generatedFileCount === 0
			? "docs-only"
			: files.sourceFileCount > 0 &&
					files.docsFileCount === 0 &&
					files.testFileCount === 0 &&
					files.generatedFileCount === 0
				? "source-only"
				: files.testFileCount > 0 &&
						files.sourceFileCount === 0 &&
						files.docsFileCount === 0 &&
						files.generatedFileCount === 0
					? "test-only"
					: files.generatedFileCount > 0 &&
							files.sourceFileCount === 0 &&
							files.docsFileCount === 0 &&
							files.testFileCount === 0
						? "generated-only"
						: files.lockfileCount > 0 || files.packageManifestCount > 0
							? "dependency/config"
							: files.docsFileCount > 0 && files.sourceFileCount > 0
								? "docs+source"
								: files.testFileCount > 0 && files.sourceFileCount > 0
									? "tests+source"
									: "mixed";
	return scope;
}

export function buildDetailedRoutingContext(input: BuildDetailedRoutingContextInput): string {
	const { band, signals, commits, files } = input;
	const generatedRatio = formatPercent(signals.generatedChurn, signals.rawChurn);
	const sourceRatio = formatPercent(signals.sourceChurn, signals.rawChurn);
	const scope = summarizeScope(files);
	const flags = [
		signals.hasBreakingChange ? "breaking" : "",
		signals.hasBinaryFiles ? "binary" : "",
		files.lockfileCount > 0 ? "lockfiles" : "",
		files.packageManifestCount > 0 ? "package-manifests" : "",
		files.docsFileCount > 0 && files.sourceFileCount > 0 ? "docs+src" : "",
		files.testFileCount > 0 && files.sourceFileCount > 0 ? "tests+src" : "",
	].filter(Boolean);
	const decisionReason =
		band === "C"
			? "broad / cross-cutting / breaking"
			: band === "A"
				? "tight / docs-only / generated-heavy"
				: "mixed but bounded";
	const lines = [
		`decision: band=${band}; reason=${decisionReason}`,
		`intent: ${formatCountLabel(commits.semanticCommitCount, "semantic commit")}; merge=${commits.mergeCommitCount}; breaking=${commits.breakingCommitCount}; types=${formatTypeCounts(commits.typeCounts)}`,
		`subjects: ${joinList(commits.subjects.slice(0, 3))}`,
		`scope: ${scope}; dirs=${joinList(files.topLevelDirs.slice(0, 8))}`,
		`file-kinds: source=${files.sourceFileCount}; docs=${files.docsFileCount}; test=${files.testFileCount}; generated=${files.generatedFileCount}; lockfiles=${files.lockfileCount}; package-manifests=${files.packageManifestCount}`,
		`churn: raw=${files.rawChurn}; source=${files.sourceChurn}; generated=${files.generatedChurn}; generated-share=${generatedRatio}; source-share=${sourceRatio}`,
		`hotspots: files=${formatHotspots(files.topFiles.slice(0, 5))}; dirs=${formatHotspots(files.topDirs.slice(0, 5))}`,
		`risk: ${flags.length === 0 ? "none" : flags.join(", ")}`,
		`compact: ${buildRoutingContext({ band, signals })}`,
		"policy: prefer user-visible and breaking changes over lockfiles/generated churn.",
	];
	return lines.join("\n");
}
