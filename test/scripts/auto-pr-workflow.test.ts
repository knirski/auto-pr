import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workflowJob(workflowName: string, jobName: string): Record<string, unknown> {
  const workflow = Bun.YAML.parse(
    readFileSync(join(repoRoot, ".github/workflows", workflowName), "utf8"),
  );
  if (!isRecord(workflow) || !isRecord(workflow.jobs) || !isRecord(workflow.jobs[jobName])) {
    throw new Error(`Expected job '${jobName}' in ${workflowName}`);
  }
  return workflow.jobs[jobName];
}

function workflowSteps(job: Record<string, unknown>): readonly Record<string, unknown>[] {
  return Array.isArray(job.steps) ? job.steps.filter(isRecord) : [];
}

function namedStep(job: Record<string, unknown>, name: string): Record<string, unknown> {
  const step = workflowSteps(job).find((candidate) => candidate.name === name);
  if (step === undefined) {
    throw new Error(`Expected step '${name}'`);
  }
  return step;
}

function runWorkflowStep(options: {
  workflowName: string;
  jobName: string;
  stepName: string;
  env: Readonly<Record<string, string>>;
  setup?: (directory: string) => void;
}): { output: string; status: number | null; stderr: string } {
  const directory = mkdtempSync(join(tmpdir(), "auto-pr-workflow-step-"));
  try {
    const outputPath = join(directory, "github-output");
    options.setup?.(directory);
    const step = namedStep(workflowJob(options.workflowName, options.jobName), options.stepName);
    if (typeof step.run !== "string") {
      throw new Error(`Expected run script for step '${options.stepName}'`);
    }
    const result = spawnSync("bash", ["-c", step.run], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        PATH: `${join(directory, "bin")}:${process.env.PATH ?? ""}`,
        ...options.env,
      },
    });
    return {
      output: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "",
      status: result.status,
      stderr: result.stderr,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function getOutputValue(output: string, key: string): string | undefined {
  return output
    .split("\n")
    .find((line) => line.startsWith(`${key}=`))
    ?.slice(key.length + 1);
}

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

  test("validates source branches before checkout and generation", () => {
    const generateWorkflow = readFileSync(
      join(repoRoot, ".github/workflows/auto-pr-generate-reusable.yml"),
      "utf8",
    );

    expect(generateWorkflow).toContain("Validate source branch");
    expect(generateWorkflow).toContain("pulls?state=all&per_page=100");
    expect(generateWorkflow).toContain("30 days ago");
    expect(generateWorkflow).toContain("source_branch");
    expect(generateWorkflow).toContain("head_sha");
    expect(generateWorkflow).toContain("steps.validate.outputs.skip != 'true'");
    expect(generateWorkflow.indexOf("Validate source branch")).toBeLessThan(
      generateWorkflow.indexOf("Checkout branch"),
    );
    expect(generateWorkflow).toContain("if: steps.validate.outputs.skip != 'true'");
    expect(generateWorkflow).toContain(
      "if: steps.validate.outputs.skip != 'true' && steps.semantic.outputs.should_create_pr == 'true'",
    );
  });

  test("uploads a skipped marker when validation skips generation", () => {
    const generateWorkflow = readFileSync(
      join(repoRoot, ".github/workflows/auto-pr-generate-reusable.yml"),
      "utf8",
    );
    const prepareArtifact = generateWorkflow.slice(
      generateWorkflow.indexOf("- name: Prepare artifact"),
      generateWorkflow.indexOf("- name: Upload PR content"),
    );
    const uploadArtifact = generateWorkflow.slice(
      generateWorkflow.indexOf("- name: Upload PR content"),
    );

    expect(prepareArtifact).toContain(
      'status: (if $status == "true" then "generated" else "skipped" end)',
    );
    expect(prepareArtifact).not.toContain("if: steps.validate.outputs.skip != 'true'");
    expect(uploadArtifact).not.toContain("if: steps.validate.outputs.skip != 'true'");
  });

  test("gives branches sharing a commit distinct immutable artifact names", () => {
    const generateJob = workflowJob("auto-pr-generate-reusable.yml", "generate");
    const upload = namedStep(generateJob, "Upload PR content");
    const headSha = "a".repeat(40);
    const runPrepare = (branch: string) =>
      runWorkflowStep({
        workflowName: "auto-pr-generate-reusable.yml",
        jobName: "generate",
        stepName: "Prepare artifact",
        env: {
          BRANCH: branch,
          DEFAULT_BRANCH: "main",
          GITHUB_WORKSPACE: "/unused-for-skipped-artifact",
          HEAD_SHA: headSha,
          SHOULD_CREATE_PR: "false",
          SOURCE_REPOSITORY: "knirski/auto-pr",
        },
      });

    const first = runPrepare("ai/first");
    const second = runPrepare("ai/second");
    const firstName = getOutputValue(first.output, "name");
    const secondName = getOutputValue(second.output, "name");

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(firstName).toMatch(/^pr-content-[a-f0-9]{40}-[a-f0-9]{64}$/);
    expect(secondName).toMatch(/^pr-content-[a-f0-9]{40}-[a-f0-9]{64}$/);
    expect(firstName).not.toBe(secondName);
    expect(upload.with).toEqual({
      name: `\${{ steps.artifact.outputs.name }}`,
      path: "pr-content/",
    });
  });

  test("enumerates the triggering run artifacts and fans out one create call per artifact", () => {
    const enumerateJob = workflowJob("auto-pr-create.yml", "enumerate");
    const createJob = workflowJob("auto-pr-create.yml", "create");
    const enumerate = namedStep(enumerateJob, "Enumerate PR content artifacts");

    expect(enumerate.run).toContain("actions/runs/$RUN_ID/artifacts?per_page=100");
    expect(enumerateJob.outputs).toEqual({
      has_artifacts: `\${{ steps.artifacts.outputs.has_artifacts }}`,
      matrix: `\${{ steps.artifacts.outputs.matrix }}`,
    });
    expect(createJob.needs).toBe("enumerate");
    expect(createJob.if).toBe("needs.enumerate.outputs.has_artifacts == 'true'");
    expect(createJob.strategy).toEqual({
      "fail-fast": false,
      matrix: `\${{ fromJSON(needs.enumerate.outputs.matrix) }}`,
    });
    expect(createJob.with).toEqual({
      artifact_name: `\${{ matrix.artifact_name }}`,
      conclusion: `\${{ github.event.workflow_run.conclusion }}`,
      source_repository: `\${{ github.event.workflow_run.repository.full_name }}`,
      workflow_run_id: `\${{ github.event.workflow_run.id }}`,
    });
  });

  test("derives scheduled source identity from the selected artifact manifest", () => {
    const createWorkflow = readFileSync(
      join(repoRoot, ".github/workflows/auto-pr-create-reusable.yml"),
      "utf8",
    );
    const createJob = workflowJob("auto-pr-create-reusable.yml", "create");
    const download = namedStep(createJob, "Download selected PR content artifact");
    const firstTipCheck = namedStep(createJob, "Re-resolve branch tip before minting token");

    expect(createWorkflow).not.toContain("inputs.head_branch");
    expect(createWorkflow).not.toContain("inputs.head_sha");
    expect(download.with).toEqual({
      "github-token": `\${{ github.token }}`,
      name: `\${{ inputs.artifact_name }}`,
      path: `\${{ runner.temp }}/pr-artifact`,
      "run-id": `\${{ inputs.workflow_run_id }}`,
    });
    expect(firstTipCheck.env).toEqual({
      EXPECTED_HEAD_SHA: `\${{ steps.manifest.outputs.head_sha }}`,
      GH_TOKEN: `\${{ github.token }}`,
      HEAD_BRANCH: `\${{ steps.manifest.outputs.branch }}`,
      REPO: `\${{ github.repository }}`,
    });
    expect(createWorkflow).toContain("manifest.source_repository");
    expect(createWorkflow).toContain("manifest.source_branch");
    expect(createWorkflow).toContain("manifest.default_branch");
    expect(createWorkflow).toContain("manifest.head_sha");
    expect(createWorkflow).toContain("steps.artifact.outputs.branch_identity");
    expect(createWorkflow).toContain("printf '%s' \"$m_branch\" | sha256sum");
    expect(createWorkflow).toContain("steps.manifest.outputs.skipped != 'true'");
  });

  test("tolerates deleted-fork PRs and ignores matching refs from other repositories", () => {
    const generateWorkflow = readFileSync(
      join(repoRoot, ".github/workflows/auto-pr-generate-reusable.yml"),
      "utf8",
    );
    const headSha = "a".repeat(40);
    const result = runWorkflowStep({
      workflowName: "auto-pr-generate-reusable.yml",
      jobName: "generate",
      stepName: "Validate source branch",
      env: {
        EXPECTED_SHA: headSha,
        GH_TOKEN: "test-token",
        REPO: "knirski/auto-pr",
        SOURCE_BRANCH: "ai/source",
      },
      setup: (directory) => {
        const binDirectory = join(directory, "bin");
        const ghPath = join(binDirectory, "gh");
        mkdirSync(binDirectory);
        writeFileSync(
          ghPath,
          `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *"git/ref/heads/ai/source"*) printf '%s' '{"object":{"sha":"${headSha}"}}' ;;
  *"commits/${headSha}"*) printf '%s' '{"commit":{"committer":{"date":"2099-01-01T00:00:00Z"}}}' ;;
  *"pulls?state=all&per_page=100"*) printf '%s' '[{"head":{"ref":"ai/deleted","repo":null}},{"head":{"ref":"ai/missing"}},{"head":{"ref":"ai/source","repo":{"full_name":"fork/repo"}}}]' ;;
  *) exit 64 ;;
esac
`,
        );
        chmodSync(ghPath, 0o755);
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.output).toContain("skip=false\n");
    expect(generateWorkflow).toContain(
      ".head.ref == $source_branch and .head.repo.full_name? == $repo",
    );
  });
});
