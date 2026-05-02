import { describe, expect, test } from "bun:test";
import {
	buildCommitSummary,
	buildFileSummary,
	classifyFile,
} from "../../src/core/model-routing-context-core.js";

describe("model-routing-context-core", () => {
	test("classifyFile identifies key routing kinds", () => {
		expect(classifyFile("src/app.ts")).toBe("source");
		expect(classifyFile("docs/guide.md")).toBe("docs");
		expect(classifyFile("test/app.test.ts")).toBe("test");
		expect(classifyFile("dist/bundle.js.map")).toBe("generated");
		expect(classifyFile("bun.lock")).toBe("lockfile");
		expect(classifyFile("package.json")).toBe("package");
		expect(classifyFile("misc.txt")).toBe("other");
	});

	test("buildFileSummary keeps docs churn out of source churn", () => {
		const summary = buildFileSummary({
			files: ["docs/guide.md"],
			numstat: ["12\t3\tdocs/guide.md"],
			nameStatus: ["M\tdocs/guide.md"],
		});

		expect(summary.docsFileCount).toBe(1);
		expect(summary.sourceFileCount).toBe(0);
		expect(summary.rawChurn).toBe(15);
		expect(summary.sourceChurn).toBe(0);
		expect(summary.generatedChurn).toBe(0);
	});

	test("buildCommitSummary aggregates semantic types and breaking commits", () => {
		const summary = buildCommitSummary(
			[
				{ type: "feat", breaking: false },
				{ type: "fix", breaking: true },
				{ type: undefined, breaking: false },
				{ type: "feat", breaking: false },
			],
			2,
		);

		expect(summary.semanticCommitCount).toBe(4);
		expect(summary.mergeCommitCount).toBe(2);
		expect(summary.breakingCommitCount).toBe(1);
		expect(summary.typeCounts).toEqual({ feat: 2, fix: 1 });
	});

	test("buildFileSummary tracks status counters and binary/generated churn", () => {
		const summary = buildFileSummary({
			files: ["src/app.ts", "dist/bundle.js.map", "bun.lock", "package.json", "misc.txt"],
			numstat: [
				"3\t1\tsrc/app.ts",
				"1\t0\tdist/bundle.js.map",
				"-\t-\tassets/logo.png",
				"1\t0\tmisc.txt",
			],
			nameStatus: [
				"A\tsrc/app.ts",
				"M\tdist/bundle.js.map",
				"D\tobsolete.ts",
				"R100\told.ts\tnew.ts",
				"X\tunknown-status.txt",
			],
		});

		expect(summary.addedFileCount).toBe(1);
		expect(summary.modifiedFileCount).toBe(1);
		expect(summary.deletedFileCount).toBe(1);
		expect(summary.renamedFileCount).toBe(1);
		expect(summary.hasBinaryFiles).toBe(true);
		expect(summary.sourceChurn).toBe(4);
		expect(summary.generatedChurn).toBe(1);
		expect(summary.lockfileCount).toBe(1);
		expect(summary.packageManifestCount).toBe(1);
	});
});
