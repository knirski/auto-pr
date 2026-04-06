import { describe, expect, test } from "bun:test";
import { buildDescriptionPrompt } from "#core/prompt.js";

describe("buildDescriptionPrompt", () => {
	test("includes diffstat when provided", () => {
		const result = buildDescriptionPrompt(
			"System prompt.",
			" src/a.ts | 10 +++\n 1 file changed",
			"- feat: add a",
		);
		expect(result).toContain("System prompt.");
		expect(result).toContain("Changed files (diff stat):");
		expect(result).toContain("src/a.ts | 10 +++");
		expect(result).toContain("Commits:\n- feat: add a");
	});

	test("omits diffstat section when empty string", () => {
		const result = buildDescriptionPrompt("System prompt.", "", "- feat: add a");
		expect(result).not.toContain("Changed files");
		expect(result).toContain("Commits:\n- feat: add a");
	});

	test("backwards compat: works with undefined diffstat", () => {
		// biome-ignore lint/suspicious/noExplicitAny: testing runtime behaviour with wrong type
		const result = buildDescriptionPrompt("System prompt.", undefined as any, "- feat: add a");
		expect(result).toContain("Commits:\n- feat: add a");
	});
});
