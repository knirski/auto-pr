import { describe, expect, test } from "bun:test";
import type { ModelBandSignals } from "#core/model-band.js";
import {
	buildDetailedRoutingContext,
	type RoutingContextCommitSummary,
	type RoutingContextFileSummary,
} from "#core/routing-context.js";

function signals(): ModelBandSignals {
	return {
		semanticCommitCount: 3,
		conventionalTypeCount: 2,
		topLevelSpread: 2,
		changedFileCount: 4,
		sourceFileCount: 2,
		docsFileCount: 1,
		testFileCount: 1,
		generatedFileCount: 0,
		lockfileCount: 1,
		packageManifestCount: 0,
		rawChurn: 120,
		sourceChurn: 100,
		generatedChurn: 20,
		hasBreakingChange: true,
		hasBinaryFiles: false,
	};
}

function commits(): RoutingContextCommitSummary {
	return {
		semanticCommitCount: 3,
		mergeCommitCount: 0,
		breakingCommitCount: 1,
		typeCounts: {
			feat: 1,
			fix: 1,
			docs: 1,
		},
	};
}

function files(): RoutingContextFileSummary {
	return {
		changedFiles: [
			"src/workflow/auto-pr-generate-content.ts",
			"src/core/model-band.ts",
			"docs/superpowers/spec.md",
			"test/core/model-band.test.ts",
			"bun.lock",
		],
		topLevelDirs: ["src", "docs", "test"],
		topFiles: [
			{
				path: "src/workflow/auto-pr-generate-content.ts",
				churn: 45,
				insertions: 30,
				deletions: 15,
				kind: "source",
			},
			{ path: "src/core/model-band.ts", churn: 30, insertions: 20, deletions: 10, kind: "source" },
			{ path: "docs/superpowers/spec.md", churn: 20, insertions: 20, deletions: 0, kind: "docs" },
		],
		topDirs: [
			{ path: "src", churn: 75, insertions: 50, deletions: 25, kind: "source" },
			{ path: "docs", churn: 20, insertions: 20, deletions: 0, kind: "docs" },
			{ path: "test", churn: 10, insertions: 10, deletions: 0, kind: "test" },
		],
		sourceFileCount: 2,
		docsFileCount: 1,
		testFileCount: 1,
		generatedFileCount: 0,
		lockfileCount: 1,
		packageManifestCount: 0,
		rawChurn: 120,
		sourceChurn: 100,
		generatedChurn: 20,
		hasBinaryFiles: false,
		addedFileCount: 1,
		modifiedFileCount: 4,
		deletedFileCount: 0,
		renamedFileCount: 0,
	};
}

describe("buildDetailedRoutingContext", () => {
	test("includes analysis-oriented sections without repeating commit subjects", () => {
		const ctx = buildDetailedRoutingContext({
			band: "B",
			selectedModel: "openai/gpt-4.1",
			toolStrategy: "hotspot",
			reasoningNeed: "medium",
			requiresToolCalls: true,
			signals: signals(),
			commits: commits(),
			files: files(),
		});

		expect(ctx).toContain("decision:");
		expect(ctx).toContain("intent:");
		expect(ctx).toContain("scope:");
		expect(ctx).toContain("churn:");
		expect(ctx).toContain("hotspots:");
		expect(ctx).toContain("review_focus:");
		expect(ctx).toContain("tool_guidance:");
		expect(ctx).toContain("model_route:");
		expect(ctx).toContain("coverage_signal: source+tests");
		expect(ctx).toContain("sensitive_scope:");
		expect(ctx).toContain("public_surface:");
		expect(ctx).toContain("feat=1");
		expect(ctx).toContain("lockfiles=1");
		expect(ctx).toContain("src/workflow/auto-pr-generate-content.ts");
		expect(ctx).not.toContain("subjects:");
		expect(ctx).not.toContain("compact:");
		expect(ctx).not.toContain("feat: add routing");
	});
});
