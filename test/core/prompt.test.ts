import { describe, expect, test } from "bun:test";
import { buildDescriptionPrompt } from "#core/prompt.js";

describe("buildDescriptionPrompt", () => {
  test("includes diffstat when provided", () => {
    const result = buildDescriptionPrompt(
      "System prompt.",
      "- feat: add a",
      " src/a.ts | 10 +++\n 1 file changed",
    );
    expect(result).toContain("System prompt.");
    expect(result).toContain("Changed files (diff stat):");
    expect(result).toContain("src/a.ts | 10 +++");
    expect(result).toContain("Commits:\n- feat: add a");
  });

  test("omits diffstat section when empty string", () => {
    const result = buildDescriptionPrompt("System prompt.", "- feat: add a", "");
    expect(result).not.toContain("Changed files");
    expect(result).toContain("Commits:\n- feat: add a");
  });

  test("omits diffstat section when diffstat is omitted", () => {
    const result = buildDescriptionPrompt("System prompt.", "- feat: add a");
    expect(result).toContain("Commits:\n- feat: add a");
  });

  test("includes existing PR title section after commits when provided", () => {
    const result = buildDescriptionPrompt(
      "System prompt.",
      "- feat: add a",
      "",
      "feat: prior title",
    );
    const commitsIdx = result.indexOf("Commits:\n- feat: add a");
    const existingIdx = result.indexOf("Existing PR title");
    expect(commitsIdx).not.toBe(-1);
    expect(existingIdx).not.toBe(-1);
    expect(existingIdx).toBeGreaterThan(commitsIdx);
    expect(result).toContain("feat: prior title");
  });

  test("omits existing PR title section when empty or whitespace", () => {
    expect(buildDescriptionPrompt("S.", "- a", "", "")).not.toContain("Existing PR title");
    expect(buildDescriptionPrompt("S.", "- a", "", "   ")).not.toContain("Existing PR title");
  });

  test("includes routing context section after commits and diff stat when provided", () => {
    const result = buildDescriptionPrompt(
      "System prompt.",
      "- feat: add a",
      " src/a.ts | 10 +++\n 1 file changed",
      undefined,
      "Trusted change analysis:\nmodel_route: band=B",
    );
    const diffIdx = result.indexOf("Changed files (diff stat):");
    const routingIdx = result.indexOf("Routing context:");
    const commitsIdx = result.indexOf("Commits:\n- feat: add a");
    expect(diffIdx).not.toBe(-1);
    expect(routingIdx).not.toBe(-1);
    expect(commitsIdx).not.toBe(-1);
    expect(commitsIdx).toBeLessThan(diffIdx);
    expect(diffIdx).toBeLessThan(routingIdx);
  });

  test("omits routing context section when empty or whitespace", () => {
    expect(buildDescriptionPrompt("S.", "- a", "", undefined, "")).not.toContain("Routing context");
    expect(buildDescriptionPrompt("S.", "- a", "", undefined, "   ")).not.toContain(
      "Routing context",
    );
  });
});
