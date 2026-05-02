/**
 * Pure prompt-context builder for model routing.
 */

import type { ModelBand, ModelBandSignals, ReasoningNeed, ToolStrategy } from "#core/model-band.js";

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
};

export type RoutingContextFileSummary = {
	readonly changedFiles: readonly string[];
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
	readonly addedFileCount: number;
	readonly modifiedFileCount: number;
	readonly deletedFileCount: number;
	readonly renamedFileCount: number;
};

export type BuildDetailedRoutingContextInput = {
	readonly band: ModelBand;
	readonly selectedModel: string;
	readonly toolStrategy: ToolStrategy;
	readonly reasoningNeed: ReasoningNeed;
	readonly requiresToolCalls: boolean;
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
						: files.docsFileCount > 0 && files.sourceFileCount > 0
							? "docs+source"
							: files.testFileCount > 0 && files.sourceFileCount > 0
								? "tests+source"
								: files.lockfileCount > 0 || files.packageManifestCount > 0
									? "dependency/config"
									: "mixed";
	return scope;
}

function summarizeCoverage(files: RoutingContextFileSummary): string {
	if (files.sourceFileCount > 0 && files.testFileCount > 0) return "source+tests";
	if (files.sourceFileCount > 0) return "source-without-tests";
	if (files.testFileCount > 0) return "tests-only";
	return "no-source";
}

function summarizeReviewFocus(files: RoutingContextFileSummary): string {
	const priorityKinds = new Set(["source", "test", "package", "lockfile", "other"]);
	const focused = files.topFiles.filter((file) => priorityKinds.has(file.kind));
	const hotspots = focused.length > 0 ? focused : files.topFiles;
	return formatHotspots(hotspots.slice(0, 3));
}

function summarizeSensitiveScope(files: RoutingContextFileSummary): string {
	const paths = files.changedFiles;
	const scopes = [
		paths.some((path) => path.startsWith(".github/workflows/")) ? "workflows" : "",
		paths.some((path) => path.startsWith(".github/actions/")) ? "composite-actions" : "",
		paths.some((path) => path.startsWith("src/auto-pr/prompts/")) ? "prompts" : "",
		paths.some((path) => path === "src/auto-pr/config.ts" || path.includes(".env"))
			? "config/env"
			: "",
		paths.some((path) => /(auth|token|secret|ai-provider|pull-request-client)/i.test(path))
			? "auth/provider"
			: "",
		paths.some((path) =>
			/^(package(?:-lock)?\.json|bun\.lock|bun\.lockb|bun\.nix|flake\.(nix|lock))$/.test(path),
		)
			? "dependencies"
			: "",
		paths.some((path) => path === "src/core/index.ts" || path === "src/auto-pr/index.ts")
			? "exported-api"
			: "",
	].filter(Boolean);
	return scopes.length === 0 ? "none" : scopes.join(", ");
}

function summarizePublicSurface(files: RoutingContextFileSummary): string {
	const paths = files.changedFiles;
	const surfaces = [
		paths.some((path) => path.endsWith("action.yml") || path.startsWith(".github/workflows/"))
			? "workflow/action contract"
			: "",
		paths.some((path) => path.startsWith("src/tools/")) ? "cli" : "",
		paths.some((path) => path.startsWith("src/workflow/")) ? "workflow command" : "",
		paths.some((path) => path === "src/auto-pr/config.ts") ? "config/env" : "",
		paths.some((path) => path.startsWith("src/auto-pr/prompts/")) ? "prompt" : "",
		paths.some((path) => path === "src/core/index.ts" || path === "src/auto-pr/index.ts")
			? "exported-api"
			: "",
	].filter(Boolean);
	return surfaces.length === 0 ? "none" : surfaces.join(", ");
}

function summarizeChangeShape(input: {
	readonly scope: string;
	readonly signals: ModelBandSignals;
	readonly files: RoutingContextFileSummary;
	readonly generatedRatio: string;
}): string {
	const { scope, signals, files, generatedRatio } = input;
	const shapes = [
		scope,
		signals.rawChurn > 0 && signals.generatedChurn * 100 >= signals.rawChurn * 80
			? `generated-heavy (${generatedRatio})`
			: "",
		files.addedFileCount > 0 ? `added=${files.addedFileCount}` : "",
		files.modifiedFileCount > 0 ? `modified=${files.modifiedFileCount}` : "",
		files.deletedFileCount > 0 ? `deleted=${files.deletedFileCount}` : "",
		files.renamedFileCount > 0 ? `renamed=${files.renamedFileCount}` : "",
		signals.topLevelSpread >= 3 ? `cross-dir=${signals.topLevelSpread}` : "",
	].filter(Boolean);
	return shapes.join(", ");
}

function summarizeToolGuidance(toolStrategy: ToolStrategy): string {
	const guidance: Record<ToolStrategy, string> = {
		none: "no tools needed; use commits and diff stat",
		hotspot: "inspect review_focus files before writing risks or reviewer notes",
		"full-diff": "inspect full diff first; if truncated, inspect review_focus files",
		"commit-diff": "inspect commit diffs for mixed intent before writing risks",
	};
	return guidance[toolStrategy];
}

export function buildDetailedRoutingContext(input: BuildDetailedRoutingContextInput): string {
	const {
		band,
		selectedModel,
		toolStrategy,
		reasoningNeed,
		requiresToolCalls,
		signals,
		commits,
		files,
	} = input;
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
		"Trusted change analysis:",
		`decision: band=${band}; reason=${decisionReason}`,
		`intent: ${formatCountLabel(commits.semanticCommitCount, "semantic commit")}; merge=${commits.mergeCommitCount}; breaking=${commits.breakingCommitCount}; types=${formatTypeCounts(commits.typeCounts)}`,
		`scope: ${scope}; dirs=${joinList(files.topLevelDirs.slice(0, 8))}`,
		`file-kinds: source=${files.sourceFileCount}; docs=${files.docsFileCount}; test=${files.testFileCount}; generated=${files.generatedFileCount}; lockfiles=${files.lockfileCount}; package-manifests=${files.packageManifestCount}`,
		`churn: raw=${files.rawChurn}; source=${files.sourceChurn}; generated=${files.generatedChurn}; generated-share=${generatedRatio}; source-share=${sourceRatio}`,
		`hotspots: files=${formatHotspots(files.topFiles.slice(0, 5))}; dirs=${formatHotspots(files.topDirs.slice(0, 5))}`,
		`review_focus: ${summarizeReviewFocus(files)}`,
		`coverage_signal: ${summarizeCoverage(files)}`,
		`change_shape: ${summarizeChangeShape({ scope, signals, files, generatedRatio })}`,
		`public_surface: ${summarizePublicSurface(files)}`,
		`sensitive_scope: ${summarizeSensitiveScope(files)}`,
		`risk: ${flags.length === 0 ? "none" : flags.join(", ")}`,
		`tool_guidance: ${summarizeToolGuidance(toolStrategy)}`,
		`model_route: band=${band}; reasoning=${reasoningNeed}; tool_strategy=${toolStrategy}; requires_tool_calls=${requiresToolCalls ? "true" : "false"}; selected_model=${selectedModel}`,
	];
	return lines.join("\n");
}
