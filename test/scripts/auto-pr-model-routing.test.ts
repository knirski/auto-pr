import { describe, expect, test } from "bun:test";
import {
	buildDetailedRoutingContext,
	resolveBand,
	resolveLocalRunnerResources,
	resolveModelBand,
	selectModel,
} from "../../src/workflow/model-routing.js";

describe("model band routing command policy", () => {
	test("routes tiny docs-only changes to band A", () => {
		const signals = {
			semanticCommitCount: 1,
			conventionalTypeCount: 1,
			topLevelSpread: 1,
			changedFileCount: 1,
			sourceFileCount: 0,
			docsFileCount: 1,
			testFileCount: 0,
			generatedFileCount: 0,
			lockfileCount: 0,
			packageManifestCount: 0,
			rawChurn: 12,
			sourceChurn: 0,
			generatedChurn: 0,
			hasBreakingChange: false,
			hasBinaryFiles: false,
		} as const;

		expect(resolveBand(signals)).toBe("A");
		expect(selectModel("local", "A")).toBe("qwen3-1.7b-q4_k_m");
		expect(resolveModelBand({ provider: "local", signals })).toMatchObject({
			selectedModel: "qwen3-1.7b-q4_k_m",
			toolStrategy: "none",
			reasoningNeed: "low",
			requiresToolCalls: false,
		});
	});

	test("routes broad cross-cutting changes to band C", () => {
		const signals = {
			semanticCommitCount: 9,
			conventionalTypeCount: 3,
			topLevelSpread: 4,
			changedFileCount: 18,
			sourceFileCount: 9,
			docsFileCount: 2,
			testFileCount: 2,
			generatedFileCount: 1,
			lockfileCount: 1,
			packageManifestCount: 1,
			rawChurn: 2400,
			sourceChurn: 1800,
			generatedChurn: 600,
			hasBreakingChange: true,
			hasBinaryFiles: false,
		} as const;

		expect(resolveBand(signals)).toBe("C");
		expect(selectModel("github-models", "C")).toBe("openai/gpt-4.1");
		expect(resolveModelBand({ provider: "github-models", signals })).toMatchObject({
			selectedModel: "openai/gpt-4.1",
			toolStrategy: "full-diff",
			reasoningNeed: "high",
			requiresToolCalls: true,
		});
	});

	test("routes small breaking changes to band C", () => {
		const signals = {
			semanticCommitCount: 1,
			conventionalTypeCount: 1,
			topLevelSpread: 1,
			changedFileCount: 1,
			sourceFileCount: 1,
			docsFileCount: 0,
			testFileCount: 0,
			generatedFileCount: 0,
			lockfileCount: 0,
			packageManifestCount: 0,
			rawChurn: 10,
			sourceChurn: 10,
			generatedChurn: 0,
			hasBreakingChange: true,
			hasBinaryFiles: false,
		} as const;

		expect(resolveBand(signals)).toBe("C");
		expect(resolveModelBand({ provider: "github-models", signals })).toMatchObject({
			band: "C",
			toolStrategy: "full-diff",
			reasoningNeed: "high",
		});
	});

	test("explicit model override wins over provider defaults", () => {
		const signals = {
			semanticCommitCount: 1,
			conventionalTypeCount: 1,
			topLevelSpread: 1,
			changedFileCount: 1,
			sourceFileCount: 1,
			docsFileCount: 0,
			testFileCount: 0,
			generatedFileCount: 0,
			lockfileCount: 0,
			packageManifestCount: 0,
			rawChurn: 10,
			sourceChurn: 10,
			generatedChurn: 0,
			hasBreakingChange: false,
			hasBinaryFiles: false,
		} as const;

		expect(
			resolveModelBand({ provider: "github-models", explicitModel: "openai/gpt-4.1", signals })
				.selectedModel,
		).toBe("openai/gpt-4.1");
	});

	test("routes bounded source changes to a tool-capable GitHub model", () => {
		const signals = {
			semanticCommitCount: 2,
			conventionalTypeCount: 1,
			topLevelSpread: 1,
			changedFileCount: 4,
			sourceFileCount: 3,
			docsFileCount: 0,
			testFileCount: 1,
			generatedFileCount: 0,
			lockfileCount: 0,
			packageManifestCount: 0,
			rawChurn: 320,
			sourceChurn: 320,
			generatedChurn: 0,
			hasBreakingChange: false,
			hasBinaryFiles: false,
		} as const;

		expect(resolveModelBand({ provider: "github-models", signals })).toMatchObject({
			band: "B",
			selectedModel: "openai/gpt-4.1",
			toolStrategy: "hotspot",
			reasoningNeed: "medium",
			requiresToolCalls: true,
		});
	});

	test("selects local defaults from GitHub-hosted runner resources", () => {
		const signals = {
			semanticCommitCount: 1,
			conventionalTypeCount: 1,
			topLevelSpread: 1,
			changedFileCount: 1,
			sourceFileCount: 1,
			docsFileCount: 0,
			testFileCount: 0,
			generatedFileCount: 0,
			lockfileCount: 0,
			packageManifestCount: 0,
			rawChurn: 10,
			sourceChurn: 10,
			generatedChurn: 0,
			hasBreakingChange: false,
			hasBinaryFiles: false,
		} as const;
		const privateRunner = resolveLocalRunnerResources({
			runnerLabel: "ubuntu-24.04",
			repositoryVisibility: "private",
		});
		const publicRunner = resolveLocalRunnerResources({
			runnerLabel: "ubuntu-24.04",
			repositoryVisibility: "public",
		});

		expect(privateRunner).toMatchObject({ cpuCount: 2, memoryGb: 8 });
		expect(publicRunner).toMatchObject({ cpuCount: 4, memoryGb: 16 });
		expect(
			resolveModelBand({ provider: "local", signals, localModel: { runner: privateRunner } }),
		).toMatchObject({
			selectedModel: "qwen3-1.7b-q4_k_m",
			localModelResourceFit: "unknown",
		});
		expect(
			resolveModelBand({ provider: "local", signals, localModel: { runner: publicRunner } }),
		).toMatchObject({
			selectedModel: "qwen3-4b-q4_k_m",
			localModelResourceFit: "unknown",
		});
	});

	test("does not resource-size external OpenAI-compatible local endpoints", () => {
		const signals = {
			semanticCommitCount: 1,
			conventionalTypeCount: 1,
			topLevelSpread: 1,
			changedFileCount: 1,
			sourceFileCount: 1,
			docsFileCount: 0,
			testFileCount: 0,
			generatedFileCount: 0,
			lockfileCount: 0,
			packageManifestCount: 0,
			rawChurn: 10,
			sourceChurn: 10,
			generatedChurn: 0,
			hasBreakingChange: false,
			hasBinaryFiles: false,
		} as const;
		const runner = resolveLocalRunnerResources({
			runnerLabel: "ubuntu-24.04",
			repositoryVisibility: "private",
		});

		expect(
			resolveModelBand({
				provider: "local",
				signals,
				localModel: {
					runner,
					openaiCompatUrl: "https://llm.example.test/v1",
				},
			}),
		).toMatchObject({
			selectedModel: "gpt-oss",
			localModelResourceFit: "not-applicable",
			localModelRecommendation:
				"external OpenAI-compatible endpoint; default model=gpt-oss; set ai_openai_compat_model if the endpoint requires another id",
		});
	});

	test("flags bundled GGUF URLs that exceed runner resources", () => {
		const signals = {
			semanticCommitCount: 1,
			conventionalTypeCount: 1,
			topLevelSpread: 1,
			changedFileCount: 1,
			sourceFileCount: 1,
			docsFileCount: 0,
			testFileCount: 0,
			generatedFileCount: 0,
			lockfileCount: 0,
			packageManifestCount: 0,
			rawChurn: 10,
			sourceChurn: 10,
			generatedChurn: 0,
			hasBreakingChange: false,
			hasBinaryFiles: false,
		} as const;
		const runner = resolveLocalRunnerResources({
			runnerLabel: "ubuntu-24.04",
			repositoryVisibility: "private",
		});

		expect(
			resolveModelBand({
				provider: "local",
				signals,
				localModel: {
					runner,
					llamacppModelUrl: "https://example.test/models/Qwen3-14B-Q4_K_M.gguf",
				},
			}),
		).toMatchObject({
			localModelResourceFit: "risky",
			localRunnerResources:
				"github-hosted ubuntu-24.04 private/internal baseline; cpu=2; memory=8GB",
		});
	});

	test("builds analysis-oriented context without repeating commit subjects", () => {
		const ctx = buildDetailedRoutingContext({
			band: "B",
			selectedModel: "openai/gpt-4.1",
			toolStrategy: "hotspot",
			reasoningNeed: "medium",
			requiresToolCalls: true,
			localRunnerResources:
				"github-hosted ubuntu-24.04 private/internal baseline; cpu=2; memory=8GB",
			localModelResourceFit: "risky",
			localModelRecommendation: "qwen3-1.7b-q4_k_m; recommended GGUF <= 3B Q4-class on this runner",
			signals: {
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
			},
			commits: {
				semanticCommitCount: 3,
				mergeCommitCount: 0,
				breakingCommitCount: 1,
				typeCounts: { feat: 1, fix: 1, docs: 1 },
			},
			files: {
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
				],
				topDirs: [{ path: "src", churn: 75, insertions: 50, deletions: 25, kind: "source" }],
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
			},
		});

		expect(ctx).toContain("review_focus:");
		expect(ctx).toContain("tool_guidance:");
		expect(ctx).toContain("model_route:");
		expect(ctx).toContain("coverage_signal: source+tests");
		expect(ctx).toContain("local_runner:");
		expect(ctx).toContain("local_model: fit=risky");
		expect(ctx).toContain(
			"risk: breaking, lockfiles, docs+src, tests+src, local-model-resource-risk",
		);
		expect(ctx).not.toContain("subjects:");
		expect(ctx).not.toContain("compact:");
		expect(ctx).not.toContain("feat: add routing");
	});
});
