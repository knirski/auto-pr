import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();

function runSetPackageAction(options: {
  packageJson: string;
  runner: "bunx" | "npx";
  repository?: string;
  includePackageJson?: boolean;
}): { output: string; status: number | null } {
  const directory = mkdtempSync(join(tmpdir(), "auto-pr-workflow-"));
  try {
    const outputPath = join(directory, "github-output");
    if (options.includePackageJson !== false) {
      writeFileSync(join(directory, "package.json"), options.packageJson);
    }
    const result = spawnSync(
      "bash",
      [join(repoRoot, ".github/actions/auto-pr-set-pkg/auto-pr-set-pkg.sh")],
      {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: outputPath,
          REPO: options.repository ?? "knirski/auto-pr",
          RUNNER: options.runner,
        },
      },
    );
    return { output: readFileSync(outputPath, "utf8"), status: result.status };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("auto-pr workflow selection", () => {
  test("does not select workspace mode when Bun is unavailable", () => {
    const result = runSetPackageAction({ packageJson: '{"name":"old-branch"}', runner: "npx" });

    expect(result.status).toBe(0);
    expect(result.output).toContain("use_workspace=false\n");
  });

  test("does not select workspace mode when package.json is missing", () => {
    const result = runSetPackageAction({
      packageJson: "{}",
      runner: "bunx",
      includePackageJson: false,
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain("use_workspace=false\n");
  });

  test("does not select workspace mode when current workflow scripts are missing", () => {
    const result = runSetPackageAction({
      packageJson: JSON.stringify({ name: "old-branch", scripts: { "generate-content": "true" } }),
      runner: "bunx",
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain("use_workspace=false\n");
  });

  test("selects workspace mode only when both scripts and Bun are available", () => {
    const result = runSetPackageAction({
      packageJson: JSON.stringify({
        name: "current-branch",
        autoPr: { workspaceCommands: "detached-head-v1" },
        scripts: {
          "build-model-routing-context":
            "bun run src/workflow/auto-pr-build-model-routing-context.ts",
          "generate-content": "bun run src/workflow/auto-pr-generate-content.ts",
        },
      }),
      runner: "bunx",
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain("use_workspace=true\n");
  });

  test("does not select workspace mode for a stale branch with both scripts", () => {
    const result = runSetPackageAction({
      packageJson: JSON.stringify({
        name: "stale-branch",
        scripts: {
          "build-model-routing-context":
            "bun run src/workflow/auto-pr-build-model-routing-context.ts",
          "generate-content": "bun run src/workflow/auto-pr-generate-content.ts",
        },
      }),
      runner: "bunx",
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain("use_workspace=false\n");
  });

  test("documents clean no-semantic-commit handling across both workflows", () => {
    const commandScript = readFileSync(
      join(repoRoot, ".github/actions/auto-pr-run-command/auto-pr-run-command.sh"),
      "utf8",
    );
    const setPackageAction = readFileSync(
      join(repoRoot, ".github/actions/auto-pr-set-pkg/action.yml"),
      "utf8",
    );
    const generateWorkflow = readFileSync(
      join(repoRoot, ".github/workflows/auto-pr-generate-reusable.yml"),
      "utf8",
    );
    const createWorkflow = readFileSync(
      join(repoRoot, ".github/workflows/auto-pr-create-reusable.yml"),
      "utf8",
    );

    expect(commandScript).toContain(
      'if [ "$USE_WORKSPACE" = "true" ] && [ "$RUNNER" = "bunx" ]; then',
    );
    expect(setPackageAction).toContain("runner:");
    expect(generateWorkflow).toContain("Check for semantic commits");
    expect(generateWorkflow).toContain(
      'status: (if $status == "true" then "generated" else "skipped" end)',
    );
    expect(createWorkflow).toContain("manifest.status");
    expect(createWorkflow).toContain("steps.manifest.outputs.skipped != 'true'");
  });
});
