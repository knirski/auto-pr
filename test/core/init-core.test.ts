import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getInitFileSpecs, isLegacyPushWorkflow } from "#core/init-core.js";

const repoRoot = join(import.meta.dir, "..", "..");

describe("init-core", () => {
  describe("getInitFileSpecs", () => {
    test("returns specs for both workflows, template, nvmrc, and llama-server Dockerfile", () => {
      const specs = getInitFileSpecs();
      expect(specs).toHaveLength(5);
    });
    test("generate (auto-pr.yml) workflow spec has dest and from", () => {
      const specs = getInitFileSpecs();
      const workflow = specs.find((s) => s.dest === ".github/workflows/auto-pr.yml");
      expect(workflow?.dest).toBe(".github/workflows/auto-pr.yml");
      expect(workflow?.from).toBe(".github/workflows/auto-pr.yml");
    });
    test("create (auto-pr-create.yml) workflow spec is present with matching dest and from", () => {
      const specs = getInitFileSpecs();
      const createWorkflow = specs.find((s) => s.dest === ".github/workflows/auto-pr-create.yml");
      expect(createWorkflow).toBeDefined();
      expect(createWorkflow?.from).toBe(".github/workflows/auto-pr-create.yml");
    });
    test("both halves of the two-workflow architecture install together", () => {
      const dests = getInitFileSpecs().map((s) => s.dest);
      expect(dests).toContain(".github/workflows/auto-pr.yml");
      expect(dests).toContain(".github/workflows/auto-pr-create.yml");
    });
    test("only auto-pr.yml carries the legacy-detection flag", () => {
      const specs = getInitFileSpecs();
      const flagged = specs.filter((s) => s.detectLegacy === true).map((s) => s.dest);
      expect(flagged).toEqual([".github/workflows/auto-pr.yml"]);
    });
    test("nvmrc spec copies from package", () => {
      const specs = getInitFileSpecs();
      const nvmrc = specs.find((s) => s.dest === ".nvmrc");
      expect(nvmrc?.from).toBe(".nvmrc");
    });
    test("llama-server Dockerfile spec copies from package", () => {
      const specs = getInitFileSpecs();
      const llama = specs.find((s) => s.dest === ".github/llama-server/Dockerfile");
      expect(llama?.from).toBe(".github/llama-server/Dockerfile");
    });
  });

  describe("isLegacyPushWorkflow", () => {
    test("flags an old push-triggered workflow (push, no workflow_dispatch/discover)", () => {
      const legacy = [
        "name: Auto-PR",
        "on:",
        "  push:",
        "    branches:",
        '      - "ai/**"',
        "jobs:",
        "  generate:",
        "    uses: knirski/auto-pr/.github/workflows/auto-pr-generate-reusable.yml@abc",
        "  create:",
        "    uses: knirski/auto-pr/.github/workflows/auto-pr-create-reusable.yml@abc",
        "    secrets: inherit",
      ].join("\n");
      expect(isLegacyPushWorkflow(legacy)).toBe(true);
    });

    test("does not flag the new push-free workflow (workflow_dispatch + schedule + discover)", () => {
      const modern = [
        "name: Auto-PR",
        "permissions: {}",
        "on:",
        "  workflow_dispatch:",
        "    inputs:",
        "      branch:",
        '        description: "The ai/** branch"',
        "  schedule:",
        '    - cron: "*/15 * * * *"',
        "jobs:",
        "  discover:",
        "    runs-on: ubuntu-24.04",
        "  generate:",
        "    needs: discover",
      ].join("\n");
      expect(isLegacyPushWorkflow(modern)).toBe(false);
    });

    test("does not flag the actual current template shipped by this package", () => {
      const text = readFileSync(join(repoRoot, ".github", "workflows", "auto-pr.yml"), "utf8");
      expect(isLegacyPushWorkflow(text)).toBe(false);
    });
  });
});
