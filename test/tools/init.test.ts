import { describe, expect, test } from "bun:test";
import { Effect, Exit, FileSystem } from "effect";
import { runEffect } from "#test/run-effect.js";
import { createTestTempDirEffect, TestBaseLayer } from "#test/test-utils.js";
import { runInit } from "#tools/auto-pr-init.js";

describe("runInit", () => {
  test("creates both workflows, PR template, .nvmrc, and llama-server Dockerfile in target directory", async () => {
    await runEffect(TestBaseLayer)(
      Effect.gen(function* () {
        const tmp = yield* createTestTempDirEffect("auto-pr-init-");

        yield* runInit(tmp.path);

        const fs = yield* FileSystem.FileSystem;
        const [
          workflowExists,
          createWorkflowExists,
          templateExists,
          nvmrcExists,
          llamaServerDockerfileExists,
        ] = yield* Effect.all([
          fs.exists(tmp.join(".github", "workflows", "auto-pr.yml")),
          fs.exists(tmp.join(".github", "workflows", "auto-pr-create.yml")),
          fs.exists(tmp.join(".github", "PULL_REQUEST_TEMPLATE.md")),
          fs.exists(tmp.join(".nvmrc")),
          fs.exists(tmp.join(".github", "llama-server", "Dockerfile")),
        ]);

        expect(workflowExists).toBe(true);
        expect(createWorkflowExists).toBe(true);
        expect(templateExists).toBe(true);
        expect(nvmrcExists).toBe(true);
        expect(llamaServerDockerfileExists).toBe(true);

        const workflowContent = yield* fs.readFileString(
          tmp.join(".github", "workflows", "auto-pr.yml"),
        );
        expect(workflowContent).toContain("jobs:");
        expect(workflowContent).toContain("on:");

        const createWorkflowContent = yield* fs.readFileString(
          tmp.join(".github", "workflows", "auto-pr-create.yml"),
        );
        // The create workflow is the privileged, workflow_run-triggered half (ADR 0016 decision 4).
        expect(createWorkflowContent).toContain("workflow_run:");

        const nvmrcContent = yield* fs.readFileString(tmp.join(".nvmrc"));
        expect(nvmrcContent.trim()).toMatch(/^\d+$/);
      }).pipe(Effect.scoped),
    );
  });

  test("skips existing files on second run without mixing versions (both workflows unchanged)", async () => {
    await runEffect(TestBaseLayer)(
      Effect.gen(function* () {
        const tmp = yield* createTestTempDirEffect("auto-pr-init-skip-");

        yield* runInit(tmp.path);
        const workflowPath = tmp.join(".github", "workflows", "auto-pr.yml");
        const createWorkflowPath = tmp.join(".github", "workflows", "auto-pr-create.yml");
        const fs = yield* FileSystem.FileSystem;
        const workflowAfterFirst = yield* fs.readFileString(workflowPath);
        const createAfterFirst = yield* fs.readFileString(createWorkflowPath);

        yield* runInit(tmp.path);
        const workflowAfterSecond = yield* fs.readFileString(workflowPath);
        const createAfterSecond = yield* fs.readFileString(createWorkflowPath);

        // Re-running on a fresh (non-legacy) install must not overwrite either half.
        expect(workflowAfterSecond).toBe(workflowAfterFirst);
        expect(createAfterSecond).toBe(createAfterFirst);
      }).pipe(Effect.scoped),
    );
  });

  test("refuses to proceed and does not touch a legacy push-triggered auto-pr.yml (migration hazard)", async () => {
    const legacyWorkflow = [
      "name: Auto-PR",
      "on:",
      "  push:",
      "    branches:",
      '      - "ai/**"',
      "jobs:",
      "  generate:",
      "    uses: knirski/auto-pr/.github/workflows/auto-pr-generate-reusable.yml@old",
      "  create:",
      "    uses: knirski/auto-pr/.github/workflows/auto-pr-create-reusable.yml@old",
      "    secrets: inherit",
      "",
    ].join("\n");

    await runEffect(TestBaseLayer)(
      Effect.gen(function* () {
        const tmp = yield* createTestTempDirEffect("auto-pr-init-legacy-");
        const fs = yield* FileSystem.FileSystem;

        const workflowPath = tmp.join(".github", "workflows", "auto-pr.yml");
        yield* fs.makeDirectory(tmp.join(".github", "workflows"), { recursive: true });
        yield* fs.writeFileString(workflowPath, legacyWorkflow);

        // runInit must FAIL (non-zero exit at the CLI) rather than report success.
        const exit = yield* Effect.exit(runInit(tmp.path));
        expect(Exit.isFailure(exit)).toBe(true);

        // The old file must be left byte-for-byte untouched (never blindly clobbered)...
        const afterContent = yield* fs.readFileString(workflowPath);
        expect(afterContent).toBe(legacyWorkflow);

        // ...and no half-migrated state must be created (no auto-pr-create.yml written).
        const createExists = yield* fs.exists(
          tmp.join(".github", "workflows", "auto-pr-create.yml"),
        );
        expect(createExists).toBe(false);
      }).pipe(Effect.scoped),
    );
  });
});
