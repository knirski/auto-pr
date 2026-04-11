import { describe, expect, test } from "bun:test";
import { getInitFileSpecs } from "#core/init-core.js";

describe("init-core", () => {
	describe("getInitFileSpecs", () => {
		test("returns specs for workflow, template, nvmrc, and llama-ci Dockerfile", () => {
			const specs = getInitFileSpecs();
			expect(specs).toHaveLength(4);
		});
		test("workflow spec has dest and from", () => {
			const specs = getInitFileSpecs();
			const workflow = specs.find((s) => s.dest.includes("auto-pr.yml"));
			expect(workflow?.dest).toBe(".github/workflows/auto-pr.yml");
			expect(workflow?.from).toBe(".github/workflows/auto-pr.yml");
		});
		test("nvmrc spec copies from package", () => {
			const specs = getInitFileSpecs();
			const nvmrc = specs.find((s) => s.dest === ".nvmrc");
			expect(nvmrc?.from).toBe(".nvmrc");
		});
		test("llama-ci Dockerfile spec copies from package", () => {
			const specs = getInitFileSpecs();
			const llama = specs.find((s) => s.dest === ".github/llama-ci/Dockerfile");
			expect(llama?.from).toBe(".github/llama-ci/Dockerfile");
		});
	});
});
