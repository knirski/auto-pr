import { describe, expect, test } from "bun:test";
import {
	findMissingPatchCoverage,
	parseAddedLinesFromUnifiedDiff,
	parseLcovInfo,
} from "../../scripts/check-patch-coverage.js";

describe("check-patch-coverage", () => {
	test("parses added src lines from unified diff hunks", () => {
		const diff = [
			"diff --git a/src/a.ts b/src/a.ts",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -10,0 +11,2 @@",
			"+const a = 1;",
			"+const b = 2;",
			"diff --git a/test/a.test.ts b/test/a.test.ts",
			"--- a/test/a.test.ts",
			"+++ b/test/a.test.ts",
			"@@ -1,0 +1,1 @@",
			"+expect(true).toBe(true);",
			"diff --git a/src/types.d.ts b/src/types.d.ts",
			"--- a/src/types.d.ts",
			"+++ b/src/types.d.ts",
			"@@ -1,0 +1,1 @@",
			"+declare const value: string;",
		].join("\n");

		expect(parseAddedLinesFromUnifiedDiff(diff)).toEqual([
			{ file: "src/a.ts", line: 11 },
			{ file: "src/a.ts", line: 12 },
		]);
	});

	test("tracks line numbers across context and removed lines", () => {
		const diff = [
			"diff --git a/src/a.ts b/src/a.ts",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -20,3 +20,4 @@",
			" const existing = 1;",
			"-const removed = 1;",
			"+const added = 1;",
			" const after = 1;",
			"+const second = 1;",
		].join("\n");

		expect(parseAddedLinesFromUnifiedDiff(diff)).toEqual([
			{ file: "src/a.ts", line: 21 },
			{ file: "src/a.ts", line: 23 },
		]);
	});

	test("parses relative and absolute lcov source paths", () => {
		const coverage = parseLcovInfo(
			[
				"SF:src/a.ts",
				"DA:11,1",
				"DA:12,0",
				"end_of_record",
				"SF:/repo/src/b.ts",
				"DA:4,3",
				"end_of_record",
			].join("\n"),
			"/repo",
		);

		expect(coverage.get("src/a.ts")?.get(11)).toBe(1);
		expect(coverage.get("src/a.ts")?.get(12)).toBe(0);
		expect(coverage.get("src/b.ts")?.get(4)).toBe(3);
	});

	test("reports only changed instrumented lines with zero hits", () => {
		const coverage = parseLcovInfo(["SF:src/a.ts", "DA:11,1", "DA:12,0"].join("\n"));

		expect(
			findMissingPatchCoverage(
				[
					{ file: "src/a.ts", line: 11 },
					{ file: "src/a.ts", line: 12 },
					{ file: "src/a.ts", line: 13 },
				],
				coverage,
			),
		).toEqual([{ file: "src/a.ts", line: 12, hits: 0 }]);
	});
});
