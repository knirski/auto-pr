import { describe, expect, test } from "bun:test";
import {
	buildDetailedRoutingContext,
	parseCommitLog,
	resolveBand,
	resolveLocalRunnerResources,
	resolveModelBand,
	selectModel,
} from "../../src/core/model-routing.js";

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

	test("routes cross-cutting source-heavy changes to band C", () => {
		const signals = {
			semanticCommitCount: 4,
			conventionalTypeCount: 2,
			topLevelSpread: 2,
			changedFileCount: 6,
			sourceFileCount: 3,
			docsFileCount: 2,
			testFileCount: 1,
			generatedFileCount: 0,
			lockfileCount: 0,
			packageManifestCount: 0,
			rawChurn: 450,
			sourceChurn: 420,
			generatedChurn: 0,
			hasBreakingChange: false,
			hasBinaryFiles: false,
		} as const;

		expect(resolveBand(signals)).toBe("C");
		expect(resolveModelBand({ provider: "github-models", signals })).toMatchObject({
			band: "C",
			toolStrategy: "full-diff",
			reasoningNeed: "high",
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

	test("github-models ignores explicit override and stays on policy route", () => {
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
		).toBe("microsoft/phi-4-mini-instruct");
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

	test("prefers commit-diff for commit-heavy cross-cutting changes", () => {
		const signals = {
			semanticCommitCount: 4,
			conventionalTypeCount: 2,
			topLevelSpread: 2,
			changedFileCount: 4,
			sourceFileCount: 2,
			docsFileCount: 1,
			testFileCount: 1,
			generatedFileCount: 0,
			lockfileCount: 0,
			packageManifestCount: 0,
			rawChurn: 320,
			sourceChurn: 260,
			generatedChurn: 0,
			hasBreakingChange: false,
			hasBinaryFiles: false,
		} as const;

		expect(resolveModelBand({ provider: "github-models", signals })).toMatchObject({
			band: "B",
			toolStrategy: "commit-diff",
			reasoningNeed: "medium",
			requiresToolCalls: true,
		});
	});

	test("uses no tools for small non-code changes even on github-models", () => {
		const signals = {
			semanticCommitCount: 1,
			conventionalTypeCount: 1,
			topLevelSpread: 2,
			changedFileCount: 1,
			sourceFileCount: 0,
			docsFileCount: 1,
			testFileCount: 0,
			generatedFileCount: 0,
			lockfileCount: 0,
			packageManifestCount: 0,
			rawChurn: 10,
			sourceChurn: 0,
			generatedChurn: 0,
			hasBreakingChange: false,
			hasBinaryFiles: false,
		} as const;
		expect(resolveModelBand({ provider: "github-models", signals })).toMatchObject({
			band: "A",
			toolStrategy: "none",
			requiresToolCalls: false,
		});
	});

	test("uses no tools for bounded band-B changes without source or dependency signals", () => {
		const signals = {
			semanticCommitCount: 3,
			conventionalTypeCount: 1,
			topLevelSpread: 2,
			changedFileCount: 4,
			sourceFileCount: 0,
			docsFileCount: 0,
			testFileCount: 0,
			generatedFileCount: 0,
			lockfileCount: 0,
			packageManifestCount: 0,
			rawChurn: 300,
			sourceChurn: 300,
			generatedChurn: 0,
			hasBreakingChange: false,
			hasBinaryFiles: false,
		} as const;

		expect(resolveModelBand({ provider: "github-models", signals })).toMatchObject({
			band: "B",
			toolStrategy: "none",
			requiresToolCalls: false,
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

	test("selects the large local model and runner recommendation on bigger runners", () => {
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
			resolveModelBand({
				provider: "local",
				signals,
				localModel: {
					runner: resolveLocalRunnerResources({
						runnerLabel: "ubuntu-24.04",
						repositoryVisibility: "public",
						cpuCount: 8,
						memoryGb: 24,
					}),
				},
			}),
		).toMatchObject({
			selectedModel: "gpt-oss",
			localModelRecommendation: expect.stringContaining("recommended GGUF <= 14B"),
		});

		expect(
			resolveModelBand({
				provider: "local",
				signals,
				localModel: {
					runner: resolveLocalRunnerResources({
						runnerLabel: "ubuntu-24.04",
						repositoryVisibility: "public",
						cpuCount: 8,
						memoryGb: 64,
					}),
				},
			}),
		).toMatchObject({
			selectedModel: "gpt-oss",
			localModelRecommendation: expect.stringContaining("recommended GGUF <= 32B"),
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

	test("tolerates malformed model URL percent escapes", () => {
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
					llamacppModelUrl: "https://example.test/models/%E0%A4%ZZ",
				},
			}),
		).toMatchObject({
			localModelResourceFit: "unknown",
		});
	});

	test("parses nul-separated commit logs without splitting on commit text", () => {
		const commits = parseCommitLog(
			`${[
				"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				"feat: add routing context",
				"body line 1",
				"---COMMIT--- stays inside the body",
				"",
			].join("\n")}\0${[
				"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				"fix: keep parsing intact",
				"",
			].join("\n")}\0`,
		);

		expect(commits).toHaveLength(2);
		expect(commits[0]).toMatchObject({
			subject: "feat: add routing context",
			type: "feat",
			breaking: false,
		});
		expect(commits[1]).toMatchObject({
			subject: "fix: keep parsing intact",
			type: "fix",
			breaking: false,
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
