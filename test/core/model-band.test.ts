import { describe, expect, test } from "bun:test";
import {
	buildRoutingContext,
	resolveBand,
	resolveModelBand,
	selectModel,
} from "#core/model-band.js";

describe("model band routing", () => {
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
		expect(selectModel("local", "A")).toBe("gpt-oss");
		expect(resolveModelBand({ provider: "local", signals }).selectedModel).toBe("gpt-oss");
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
		expect(resolveModelBand({ provider: "github-models", signals }).selectedModel).toBe(
			"openai/gpt-4.1",
		);
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

	test("builds a rich routing context string", () => {
		const signals = {
			semanticCommitCount: 3,
			conventionalTypeCount: 2,
			topLevelSpread: 2,
			changedFileCount: 6,
			sourceFileCount: 3,
			docsFileCount: 1,
			testFileCount: 1,
			generatedFileCount: 0,
			lockfileCount: 1,
			packageManifestCount: 1,
			rawChurn: 512,
			sourceChurn: 420,
			generatedChurn: 92,
			hasBreakingChange: false,
			hasBinaryFiles: true,
		} as const;

		const ctx = buildRoutingContext({ band: "B", signals });
		expect(ctx).toContain("band=B");
		expect(ctx).toContain("commits=3");
		expect(ctx).toContain("signals=binary,docs+src,tests+src,lockfiles,package-manifests");
	});
});
