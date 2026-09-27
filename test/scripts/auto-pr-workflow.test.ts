import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Option } from "effect";

const repoRoot = process.cwd();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workflowDocument(workflowName: string): Record<string, unknown> {
  const workflow = Bun.YAML.parse(
    readFileSync(join(repoRoot, ".github/workflows", workflowName), "utf8"),
  );
  if (!isRecord(workflow)) {
    throw new Error(`Expected a YAML mapping in ${workflowName}`);
  }
  return workflow;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected a YAML mapping for ${label}`);
  }
  return value;
}

function workflowJob(workflowName: string, jobName: string): Record<string, unknown> {
  const workflow = workflowDocument(workflowName);
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[jobName])) {
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

function fileAtCommit(sha: string, path: string): string {
  const result = spawnSync("git", ["show", `${sha}:${path}`], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git show ${sha}:${path} failed: ${result.stderr}`);
  }
  return result.stdout;
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

function runCommandAction(options: {
  autoPrPkg: string;
  trustedPackageRequired: string;
  useWorkspace: string;
}): { status: number | null; stdout: string; stderr: string } {
  const directory = mkdtempSync(join(tmpdir(), "auto-pr-run-command-"));
  try {
    // Package mode executes $RUNNER; a stub keeps the guard tests from installing anything.
    const fakeRunner = join(directory, "fake-runner");
    writeFileSync(fakeRunner, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(fakeRunner, 0o755);
    const result = spawnSync(
      "bash",
      [
        join(repoRoot, ".github/actions/auto-pr-run-command/auto-pr-run-command.sh"),
        "generate-content",
      ],
      {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          AUTO_PR_PKG: options.autoPrPkg,
          RUNNER: fakeRunner,
          TRUSTED_PACKAGE_REQUIRED: options.trustedPackageRequired,
          USE_WORKSPACE: options.useWorkspace,
        },
      },
    );
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function workflowFiles(): readonly string[] {
  return readdirSync(join(repoRoot, ".github/workflows")).filter((file) => file.endsWith(".yml"));
}

function readWorkflow(workflowName: string): string {
  return readFileSync(join(repoRoot, ".github/workflows", workflowName), "utf8");
}

function runSourceValidationAction(options: {
  expectedSha: string;
  repository?: string;
  sourceBranch: string;
  setup?: (directory: string) => void;
}): { output: string; status: number | null; stderr: string } {
  const directory = mkdtempSync(join(tmpdir(), "auto-pr-source-validation-"));
  try {
    const outputPath = join(directory, "github-output");
    options.setup?.(directory);
    const result = spawnSync(
      "bash",
      [join(repoRoot, ".github/actions/auto-pr-validate-source/validate-source.sh")],
      {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          EXPECTED_SHA: options.expectedSha,
          GITHUB_OUTPUT: outputPath,
          GH_TOKEN: "test-token",
          REPO: options.repository ?? "knirski/auto-pr",
          SOURCE_BRANCH: options.sourceBranch,
          PATH: `${join(directory, "bin")}:${process.env.PATH ?? ""}`,
        },
      },
    );
    return {
      output: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "",
      status: result.status,
      stderr: result.stderr,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function setupSourceValidationGh(
  directory: string,
  options: {
    sourceBranch: string;
    branchSha?: string;
    commitDate?: string;
    pullRequests?: string;
    missingBranch?: boolean;
  },
): void {
  const binDirectory = join(directory, "bin");
  const ghPath = join(binDirectory, "gh");
  const encodedBranch = encodeURIComponent(options.sourceBranch);
  const branchCase = options.missingBranch
    ? `  *"git/ref/heads/${encodedBranch}"*) printf '%s\\n' 'HTTP 404' >&2; exit 1 ;;`
    : `  *"git/ref/heads/${encodedBranch}"*) printf '%s' '{"object":{"sha":"${options.branchSha}"}}' ;;`;
  mkdirSync(binDirectory);
  writeFileSync(
    ghPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'case "$*" in',
      branchCase,
      `  *"commits/${options.branchSha}"*) printf '%s' '{"commit":{"committer":{"date":"${options.commitDate}"}}}' ;;`,
      `  *"pulls?state=all&per_page=100"*) printf '%s' '${options.pullRequests ?? "[]"}' ;;`,
      "  *) exit 64 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(ghPath, 0o755);
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

    expect(generateWorkflow).toContain("auto-pr-validate-source");
    expect(generateWorkflow).toContain("steps.validate.outputs.skip != 'true'");
    expect(generateWorkflow.indexOf("Validate source branch")).toBeLessThan(
      generateWorkflow.indexOf("Checkout branch"),
    );
    expect(generateWorkflow).toContain("if: steps.validate.outputs.skip != 'true'");
    expect(generateWorkflow).toContain(
      "if: steps.validate.outputs.skip != 'true' && steps.semantic.outputs.should_create_pr == 'true'",
    );
  });

  test("runs source validation from a standalone action", () => {
    const action = readFileSync(
      join(repoRoot, ".github/actions/auto-pr-validate-source/action.yml"),
      "utf8",
    );
    const generateJob = workflowJob("auto-pr-generate-reusable.yml", "generate");
    const validation = namedStep(generateJob, "Validate source branch");

    expect(action).toContain("validate-source.sh");
    expect(action).toContain("GH_TOKEN: ${{ inputs.github-token }}");
    expect(validation.uses).toMatch(/auto-pr-validate-source@[a-f0-9]{40}$/);
    expect(validation.with).toEqual({
      expected_sha: `\${{ inputs.head_sha }}`,
      repository: `\${{ github.repository }}`,
      source_branch: `\${{ inputs.source_branch }}`,
      "github-token": `\${{ github.token }}`,
    });
  });

  test("pinned validate-source action declares the inputs the caller passes", () => {
    // GitHub resolves `uses:` refs against the pinned commit, not the branch tip: the runner
    // loads auto-pr-generate-reusable.yml AT the SHA auto-pr.yml pins, then loads the action AT
    // the SHA that file pins. A uniform-pin check on the working tree alone cannot catch a pin
    // target whose own files pin an older, incompatible action (regression: run 31404948016).
    const caller = readFileSync(join(repoRoot, ".github/workflows/auto-pr.yml"), "utf8");
    const reusablePin = Option.fromNullishOr(
      caller.match(
        /^[ \t]*uses:[ \t]*knirski\/auto-pr\/\.github\/workflows\/auto-pr-generate-reusable\.yml@([a-f0-9]{40})[ \t]*$/m,
      )?.[1],
    );
    expect(Option.isSome(reusablePin)).toBe(true);

    const pinnedReusable = fileAtCommit(
      Option.getOrThrow(reusablePin),
      ".github/workflows/auto-pr-generate-reusable.yml",
    );
    const actionPin = Option.fromNullishOr(
      pinnedReusable.match(
        /^[ \t]*uses:[ \t]*knirski\/auto-pr\/\.github\/actions\/auto-pr-validate-source@([a-f0-9]{40})[ \t]*$/m,
      )?.[1],
    );
    expect(Option.isSome(actionPin)).toBe(true);

    const pinnedAction = fileAtCommit(
      Option.getOrThrow(actionPin),
      ".github/actions/auto-pr-validate-source/action.yml",
    );
    const actionYaml = Bun.YAML.parse(pinnedAction);
    const actionInputs = isRecord(actionYaml) ? actionYaml.inputs : undefined;
    expect(isRecord(actionInputs) && actionInputs["github-token"] !== undefined).toBe(true);
    expect(pinnedAction).toContain("GH_TOKEN: ${{ inputs.github-token }}");
  });

  test("source validation action emits skip=false for a current branch", () => {
    const headSha = "a".repeat(40);
    const result = runSourceValidationAction({
      expectedSha: headSha,
      sourceBranch: "ai/source",
      setup: (directory) => {
        const binDirectory = join(directory, "bin");
        const ghPath = join(binDirectory, "gh");
        mkdirSync(binDirectory);
        writeFileSync(
          ghPath,
          `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *"git/ref/heads/ai%2Fsource"*) printf '%s' '{"object":{"sha":"${headSha}"}}' ;;
  *"commits/${headSha}"*) printf '%s' '{"commit":{"committer":{"date":"2099-01-01T00:00:00Z"}}}' ;;
  *"pulls?state=all&per_page=100"*) printf '%s' '[]' ;;
  *) exit 64 ;;
esac
`,
        );
        chmodSync(ghPath, 0o755);
      },
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain("skip=false\n");
  });

  test("URL-encodes source branch names for GitHub ref lookups", () => {
    const headSha = "a".repeat(40);
    const result = runSourceValidationAction({
      expectedSha: headSha,
      sourceBranch: "ai/issue#1",
      setup: (directory) => {
        const binDirectory = join(directory, "bin");
        const ghPath = join(binDirectory, "gh");
        mkdirSync(binDirectory);
        writeFileSync(
          ghPath,
          `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *"git/ref/heads/ai%2Fissue%231"*) printf '%s' '{"object":{"sha":"${headSha}"}}' ;;
  *"commits/${headSha}"*) printf '%s' '{"commit":{"committer":{"date":"2099-01-01T00:00:00Z"}}}' ;;
  *"pulls?state=all&per_page=100"*) printf '%s' '[]' ;;
  *) exit 64 ;;
esac
`,
        );
        chmodSync(ghPath, 0o755);
      },
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain("skip=false\n");
  });

  test("skips generation when the source branch is missing", () => {
    const result = runSourceValidationAction({
      expectedSha: "a".repeat(40),
      sourceBranch: "ai/missing",
      setup: (directory) =>
        setupSourceValidationGh(directory, {
          missingBranch: true,
          sourceBranch: "ai/missing",
        }),
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain("skip=true\n");
  });

  test("skips generation when the source branch tip changed", () => {
    const result = runSourceValidationAction({
      expectedSha: "a".repeat(40),
      sourceBranch: "ai/moved",
      setup: (directory) =>
        setupSourceValidationGh(directory, {
          branchSha: "b".repeat(40),
          commitDate: "2099-01-01T00:00:00Z",
          sourceBranch: "ai/moved",
        }),
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain("skip=true\n");
  });

  test("skips generation when the source commit is expired", () => {
    const headSha = "a".repeat(40);
    const result = runSourceValidationAction({
      expectedSha: headSha,
      sourceBranch: "ai/expired",
      setup: (directory) =>
        setupSourceValidationGh(directory, {
          branchSha: headSha,
          commitDate: "2000-01-01T00:00:00Z",
          sourceBranch: "ai/expired",
        }),
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain("skip=true\n");
  });

  test("skips generation when a same-repository pull request exists", () => {
    const headSha = "a".repeat(40);
    const result = runSourceValidationAction({
      expectedSha: headSha,
      sourceBranch: "ai/already-pr",
      setup: (directory) =>
        setupSourceValidationGh(directory, {
          branchSha: headSha,
          commitDate: "2099-01-01T00:00:00Z",
          pullRequests: '[{"head":{"ref":"ai/already-pr","repo":{"full_name":"knirski/auto-pr"}}}]',
          sourceBranch: "ai/already-pr",
        }),
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain("skip=true\n");
  });

  test("create fan-out passes artifact IDs rather than artifact names", () => {
    const createWorkflow = readFileSync(
      join(repoRoot, ".github/workflows/auto-pr-create-reusable.yml"),
      "utf8",
    );
    const callerJob = workflowJob("auto-pr-create.yml", "create");
    const download = namedStep(
      workflowJob("auto-pr-create-reusable.yml", "create"),
      "Download selected PR content artifact",
    );

    expect(createWorkflow).toContain("artifact_id");
    expect(createWorkflow).not.toContain("pr-content-<SHA>-<branch-digest>");
    expect(callerJob.with).toMatchObject({ artifact_id: `\${{ matrix.artifact_id }}` });
    expect(download.with).toHaveProperty("artifact-ids", `\${{ inputs.artifact_id }}`);
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
      artifact_id: `\${{ matrix.artifact_id }}`,
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
      "artifact-ids": `\${{ inputs.artifact_id }}`,
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
    expect(createWorkflow).toContain("steps.manifest.outputs.skipped != 'true'");
  });

  test("tolerates deleted-fork PRs and ignores matching refs from other repositories", () => {
    const validationScript = readFileSync(
      join(repoRoot, ".github/actions/auto-pr-validate-source/validate-source.sh"),
      "utf8",
    );
    const headSha = "a".repeat(40);
    const result = runSourceValidationAction({
      expectedSha: headSha,
      sourceBranch: "ai/source",
      setup: (directory) => {
        const binDirectory = join(directory, "bin");
        const ghPath = join(binDirectory, "gh");
        mkdirSync(binDirectory);
        writeFileSync(
          ghPath,
          `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *"git/ref/heads/ai%2Fsource"*) printf '%s' '{"object":{"sha":"${headSha}"}}' ;;
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
    expect(validationScript).toContain(
      ".head.ref == $source_branch and .head.repo.full_name? == $repo",
    );
  });
});

describe("auto-pr-run-command trusted package mode", () => {
  const pinnedPkg = "github:knirski/auto-pr#1e377e970233a6b80abe687d06d86d0eaf350644";

  test("declares and forwards trusted_package_required", () => {
    const action = readFileSync(
      join(repoRoot, ".github/actions/auto-pr-run-command/action.yml"),
      "utf8",
    );

    expect(action).toContain("trusted_package_required:");
    expect(action).toContain(`TRUSTED_PACKAGE_REQUIRED: \${{ inputs.trusted_package_required }}`);
  });

  test("fails closed in workspace mode when a trusted package is required", () => {
    const result = runCommandAction({
      autoPrPkg: pinnedPkg,
      trustedPackageRequired: "true",
      useWorkspace: "true",
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("Trusted package mode is required");
  });

  test("fails closed when the package ref is not pinned", () => {
    const result = runCommandAction({
      autoPrPkg: "github:knirski/auto-pr",
      trustedPackageRequired: "true",
      useWorkspace: "false",
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("pinned to a 40-character SHA");
  });

  test("fails closed when the package ref uses a mutable branch", () => {
    const result = runCommandAction({
      autoPrPkg: "github:knirski/auto-pr#ai/anything",
      trustedPackageRequired: "true",
      useWorkspace: "false",
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("pinned to a 40-character SHA");
  });

  test("accepts an immutable pinned package in package mode", () => {
    const result = runCommandAction({
      autoPrPkg: pinnedPkg,
      trustedPackageRequired: "true",
      useWorkspace: "false",
    });

    expect(result.status).toBe(0);
  });

  test("does not require a pinned package when trusted mode is off", () => {
    const result = runCommandAction({
      autoPrPkg: "github:knirski/auto-pr",
      trustedPackageRequired: "false",
      useWorkspace: "false",
    });

    expect(result.status).toBe(0);
  });
});

describe("openrouter workflow wiring", () => {
  const generateReusableName = "auto-pr-generate-reusable.yml";
  const openRouterKeyEnvExpr = `\${{ inputs.ai_provider == 'openrouter' && secrets.OPENROUTER_API_KEY || '' }}`;

  test("generate reusable workflow defaults to openrouter with an optional key secret", () => {
    const workflowCall = requireRecord(
      requireRecord(workflowDocument(generateReusableName).on, `${generateReusableName} on`)
        .workflow_call,
      "workflow_call",
    );
    const inputs = requireRecord(workflowCall.inputs, "workflow_call.inputs");
    const secrets = requireRecord(workflowCall.secrets, "workflow_call.secrets");

    expect(requireRecord(inputs.ai_provider, "ai_provider").default).toBe("openrouter");
    expect(requireRecord(inputs.ai_openrouter_model, "ai_openrouter_model").default).toBe("");
    expect(
      requireRecord(inputs.ai_openrouter_http_referer, "ai_openrouter_http_referer").default,
    ).toBe("");
    expect(requireRecord(inputs.ai_openrouter_title, "ai_openrouter_title").default).toBe("");
    expect(requireRecord(secrets.OPENROUTER_API_KEY, "OPENROUTER_API_KEY").required).toBe(false);
  });

  test("generate reusable workflow drops the retired models permission", () => {
    const raw = readWorkflow(generateReusableName);
    const generateJob = workflowJob(generateReusableName, "generate");
    const permissions = requireRecord(generateJob.permissions, "generate permissions");

    expect(permissions.models).toBeUndefined();
    expect(permissions.contents).toBe("read");
    expect(permissions["pull-requests"]).toBe("read");
    expect(raw).not.toContain("models: read");
    expect(raw).not.toContain("github-models");
  });

  test("OpenRouter env reaches only the routing-context and generate-content steps", () => {
    const generateJob = workflowJob(generateReusableName, "generate");
    const keyedSteps = workflowSteps(generateJob).filter((step) =>
      JSON.stringify(step.env ?? {}).includes("OPENROUTER_API_KEY"),
    );

    expect(keyedSteps.map((step) => step.name)).toEqual([
      "Build model routing context",
      "Generate PR content",
    ]);

    const mentioningKey = workflowSteps(generateJob)
      .filter((step) =>
        `${JSON.stringify(step.env ?? {})} ${JSON.stringify(step.with ?? {})}`.includes(
          "OPENROUTER_API_KEY",
        ),
      )
      .map((step) => step.name);
    expect(mentioningKey).toEqual(["Build model routing context", "Generate PR content"]);

    for (const name of [
      "Setup runtime (Node or alternative) with cache",
      "Install dependencies (workspace only)",
      "Prepare artifact",
      "Upload PR content",
    ]) {
      expect(JSON.stringify(namedStep(generateJob, name))).not.toContain("OPENROUTER_API_KEY");
    }
  });

  test("secret-bearing steps force trusted package mode with an immutable pinned ref", () => {
    const generateJob = workflowJob(generateReusableName, "generate");
    const selfRefSha = readWorkflow(generateReusableName).match(
      /knirski\/auto-pr\/\.github\/actions\/auto-pr-validate-source@([a-f0-9]{40})/,
    )?.[1];
    expect(selfRefSha).toBeDefined();

    const keyedSteps = workflowSteps(generateJob).filter((step) =>
      JSON.stringify(step.env ?? {}).includes("OPENROUTER_API_KEY"),
    );
    expect(keyedSteps.length).toBe(2);

    for (const step of keyedSteps) {
      const withBlock = requireRecord(step.with, `${String(step.name)} with`);
      expect(withBlock.use_workspace).toContain("inputs.ai_provider == 'openrouter'");
      expect(withBlock.use_workspace).toContain("'false'");
      expect(withBlock.use_workspace).toContain("steps.auto-pr-pkg.outputs.use_workspace");
      expect(withBlock.trusted_package_required).toBe(
        `\${{ inputs.ai_provider == 'openrouter' && 'true' || 'false' }}`,
      );
      expect(withBlock.auto_pr_pkg).toMatch(/github:knirski\/auto-pr#[a-f0-9]{40}/);
      expect(withBlock.auto_pr_pkg).toContain(`github:knirski/auto-pr#${selfRefSha}`);
    }
  });

  test("keyed steps receive the OpenRouter env and provider-gated secret", () => {
    const generateJob = workflowJob(generateReusableName, "generate");
    const routingEnv = requireRecord(
      namedStep(generateJob, "Build model routing context").env,
      "routing env",
    );
    const generateEnv = requireRecord(
      namedStep(generateJob, "Generate PR content").env,
      "generate env",
    );

    for (const env of [routingEnv, generateEnv]) {
      expect(env.OPENROUTER_API_KEY).toBe(openRouterKeyEnvExpr);
      expect(env.AUTO_PR_AI_PROVIDER).toBe(`\${{ inputs.ai_provider }}`);
      expect(env.AUTO_PR_OPENROUTER_MODEL).toBe(`\${{ inputs.ai_openrouter_model }}`);
    }
    expect(routingEnv.AUTO_PR_OPENROUTER_HTTP_REFERER).toBeUndefined();
    expect(generateEnv.AUTO_PR_OPENROUTER_HTTP_REFERER).toBe(
      `\${{ inputs.ai_openrouter_http_referer }}`,
    );
    expect(generateEnv.AUTO_PR_OPENROUTER_TITLE).toBe(`\${{ inputs.ai_openrouter_title }}`);
    expect(generateEnv.GH_TOKEN).toBe(`\${{ secrets.GH_TOKEN || github.token }}`);
  });

  test("local llama steps remain gated on ai_provider == 'local'", () => {
    const generateJob = workflowJob(generateReusableName, "generate");
    for (const name of [
      "Local llama.cpp — cache key",
      "Cache llama.cpp (GGUF model + Docker image tar)",
      "Start local llama.cpp (Docker)",
    ]) {
      expect(namedStep(generateJob, name).if).toContain("inputs.ai_provider == 'local'");
    }
  });

  test("stock auto-pr workflow caps parallel generation and forwards the OpenRouter secret", () => {
    const generateJob = workflowJob("auto-pr.yml", "generate");
    const strategy = requireRecord(generateJob.strategy, "auto-pr generate strategy");
    const permissions = requireRecord(generateJob.permissions, "auto-pr generate permissions");
    const secrets = requireRecord(generateJob.secrets, "auto-pr generate secrets");

    expect(strategy["max-parallel"]).toBe(2);
    expect(strategy["fail-fast"]).toBe(false);
    expect(permissions.models).toBeUndefined();
    expect(secrets.OPENROUTER_API_KEY).toBe(`\${{ secrets.OPENROUTER_API_KEY }}`);
    expect(secrets.GH_TOKEN).toBe(`\${{ github.token }}`);
  });

  test("no workflow requests the retired GitHub Models permission", () => {
    for (const file of workflowFiles()) {
      expect(readWorkflow(file)).not.toContain("models: read");
    }
  });

  test("no workflow references secrets.OPENROUTER_API_KEY directly in if:", () => {
    for (const file of workflowFiles()) {
      expect(readWorkflow(file)).not.toMatch(/if:.*secrets\.OPENROUTER_API_KEY/);
    }
  });

  test("integration workflow exposes the OpenRouter cloud job and drops GitHub Models", () => {
    const jobs = requireRecord(workflowDocument("integration.yml").jobs, "integration jobs");
    const raw = readWorkflow("integration.yml");

    expect(jobs["integration-github-models"]).toBeUndefined();
    expect(raw).not.toContain("integration-github-models");

    const openRouterJob = requireRecord(jobs["integration-openrouter"], "integration-openrouter");
    expect(String(openRouterJob.if)).toContain("workflow_dispatch");
    expect(String(openRouterJob.if)).toContain("schedule");
    expect(requireRecord(openRouterJob.env, "integration-openrouter env").OPENROUTER_API_KEY).toBe(
      `\${{ secrets.OPENROUTER_API_KEY }}`,
    );

    const testStep = namedStep(openRouterJob, "Run integration tests (OpenRouter)");
    expect(testStep.if).toBe("env.OPENROUTER_API_KEY != ''");
    expect(requireRecord(testStep.env, "openrouter test env").AUTO_PR_AI_PROVIDER).toBe(
      "openrouter",
    );
    expect(testStep.run).toContain("test/integration/ai-providers.openrouter.integration.test.ts");
  });

  test("CI callers no longer grant GitHub Models access", () => {
    expect(readWorkflow("ci.yml")).not.toContain("models: read");
  });
});
