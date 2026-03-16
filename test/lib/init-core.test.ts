import { describe, expect, test } from "vitest";
import { getInitFileSpecs } from "#lib/init-core.js";

describe("init-core", () => {
	describe("getInitFileSpecs", () => {
		test("returns three specs", () => {
			const specs = getInitFileSpecs();
			expect(specs).toHaveLength(3);
		});
		test("workflow spec has dest and from", () => {
			const specs = getInitFileSpecs();
			const workflow = specs.find((s) => s.dest.includes("auto-pr.yml"));
			expect(workflow?.dest).toBe(".github/workflows/auto-pr.yml");
			expect(workflow?.from).toBe(".github/workflows/auto-pr.yml");
		});
		test("nvmrc spec has content", () => {
			const specs = getInitFileSpecs();
			const nvmrc = specs.find((s) => s.dest === ".nvmrc");
			expect(nvmrc?.content).toBe("24\n");
		});
	});
});
