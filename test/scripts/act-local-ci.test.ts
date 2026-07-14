import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Cause, Effect, Exit, Layer, Option, Result } from "effect";
import { Command } from "effect/unstable/cli";
import { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner, ExitCode } from "effect/unstable/process/ChildProcessSpawner";
import { AutoPrLoggerLayer, AutoPrPlatformLayer } from "#auto-pr";
import { ActLocalCiError } from "#core/errors.js";
import pkg from "../../package.json" with { type: "json" };
import {
  ACT_GENERATED_EVENT_RELATIVE_PATH,
  actLocalCiCommand,
  buildActArgv,
  CI_EVENT,
  CI_WORKFLOW,
  isActLocalCiMode,
  isGithubPullRequestRef,
  mergeActContainerOptions,
  parseGithubRepoFromPackageJsonRepository,
  parseGithubRepoFromRemoteUrl,
  parseGithubRepoFromShortName,
  planActRun,
  program,
  resolveActArtifactServerOpts,
  resolveActLocalCiInput,
  resolveActLocalCiRunnerFromProcessEnv,
  resolveActRunnerImage,
  resolveActWorkflowDispatchRepo,
  stringifyWorkflowDispatchEventJson,
} from "../../scripts/act-local-ci.js";

const repoRoot = join(import.meta.dir, "..", "..");

/** Bun platform + logger (Command needs Terminal/Stdio). */
const ActLocalCiCliTestLayer = BunServices.layer.pipe(Layer.provideMerge(AutoPrLoggerLayer));

function runCli(args: string[]): Effect.Effect<void, unknown, never> {
  return Command.runWith(actLocalCiCommand, { version: pkg.version })(args).pipe(
    Effect.provide(ActLocalCiCliTestLayer),
  );
}

function childProcessSpawnerCaptureExit0(
  invocations: Array<{ command: string; args: readonly string[] }>,
): Layer.Layer<ChildProcessSpawner> {
  return Layer.mock(ChildProcessSpawner)({
    exitCode: (cmd) => {
      if (ChildProcess.isStandardCommand(cmd)) {
        invocations.push({ command: cmd.command, args: cmd.args });
      }
      return Effect.succeed(ExitCode(0));
    },
  });
}

describe("pure helpers", () => {
  test("resolveActLocalCiInput defaults to all when mode is all", () => {
    const r = resolveActLocalCiInput(false, "all");
    expect(Result.isSuccess(r)).toBe(true);
    if (Result.isSuccess(r)) {
      expect(r.success).toEqual({ dryRun: false, mode: "all" });
    }
  });

  test("resolveActLocalCiInput dry-run + check", () => {
    const r = resolveActLocalCiInput(true, "check");
    expect(Result.isSuccess(r)).toBe(true);
    if (Result.isSuccess(r)) {
      expect(r.success).toEqual({ dryRun: true, mode: "check" });
    }
  });

  test("resolveActLocalCiInput rejects unknown mode", () => {
    const r = resolveActLocalCiInput(false, "bogus");
    expect(Result.isFailure(r)).toBe(true);
    if (Result.isFailure(r)) {
      expect(r.failure).toBeInstanceOf(ActLocalCiError);
      expect(r.failure.reason).toContain("invalid mode");
    }
  });

  test("resolveActRunnerImage uses smaller default image on GHA for check-workflows", () => {
    expect(
      resolveActRunnerImage({
        runnerImageFromEnv: undefined,
        githubActions: true,
        mode: "check-workflows",
        dryRun: false,
      }),
    ).toBe("ghcr.io/catthehacker/ubuntu:act-24.04");
  });

  test("resolveActRunnerImage uses smaller default image on GHA for dry-run check job", () => {
    expect(
      resolveActRunnerImage({
        runnerImageFromEnv: undefined,
        githubActions: true,
        mode: "check",
        dryRun: true,
      }),
    ).toBe("ghcr.io/catthehacker/ubuntu:act-24.04");
  });

  test("isGithubPullRequestRef is true only for refs/pull/*", () => {
    expect(isGithubPullRequestRef("refs/pull/144/merge")).toBe(true);
    expect(isGithubPullRequestRef("refs/pull/1/head")).toBe(true);
    expect(isGithubPullRequestRef("refs/heads/main")).toBe(false);
    expect(isGithubPullRequestRef("refs/tags/v1")).toBe(false);
  });

  test("resolveActRunnerImage respects env override", () => {
    expect(
      resolveActRunnerImage({
        runnerImageFromEnv: "custom:image",
        githubActions: true,
        mode: "check-workflows",
        dryRun: false,
      }),
    ).toBe("custom:image");
  });

  test("isActLocalCiMode recognizes modes", () => {
    expect(isActLocalCiMode("check")).toBe(true);
    expect(isActLocalCiMode("bogus")).toBe(false);
  });

  test("parseGithubRepoFromRemoteUrl accepts https and ssh", () => {
    expect(parseGithubRepoFromRemoteUrl("https://github.com/foo/bar.git")).toEqual(
      Option.some({ owner: "foo", name: "bar" }),
    );
    expect(parseGithubRepoFromRemoteUrl("git@github.com:org/repo-name.git")).toEqual(
      Option.some({ owner: "org", name: "repo-name" }),
    );
    expect(parseGithubRepoFromRemoteUrl("ssh://git@github.com/org/repo.git")).toEqual(
      Option.some({ owner: "org", name: "repo" }),
    );
    expect(Option.isNone(parseGithubRepoFromRemoteUrl("https://gitlab.com/a/b"))).toBe(true);
  });

  test("parseGithubRepoFromShortName accepts owner/repo", () => {
    expect(parseGithubRepoFromShortName("knirski/auto-pr")).toEqual(
      Option.some({ owner: "knirski", name: "auto-pr" }),
    );
    expect(Option.isNone(parseGithubRepoFromShortName("nope"))).toBe(true);
  });

  test("parseGithubRepoFromPackageJsonRepository handles url and git+https", () => {
    expect(
      parseGithubRepoFromPackageJsonRepository({
        type: "git",
        url: "https://github.com/foo/bar.git",
      }),
    ).toEqual(Option.some({ owner: "foo", name: "bar" }));
    expect(
      parseGithubRepoFromPackageJsonRepository({
        type: "git",
        url: "git+https://github.com/foo/bar.git",
      }),
    ).toEqual(Option.some({ owner: "foo", name: "bar" }));
  });

  test("resolveActWorkflowDispatchRepo prefers git remote over package.json", () => {
    const r = resolveActWorkflowDispatchRepo({
      gitRemoteOriginUrl: "https://github.com/from-git/the-repo.git",
      packageJson: { repository: { url: "https://github.com/from-pkg/other.git" } },
    });
    expect(Result.isSuccess(r)).toBe(true);
    if (Result.isSuccess(r)) {
      expect(r.success).toEqual({ owner: "from-git", name: "the-repo" });
    }
  });

  test("resolveActWorkflowDispatchRepo fails when neither source parses", () => {
    const r = resolveActWorkflowDispatchRepo({
      gitRemoteOriginUrl: "https://example.com/a.git",
      packageJson: {},
    });
    expect(Result.isFailure(r)).toBe(true);
  });

  test("resolveActWorkflowDispatchRepo uses package.json when git remote missing", () => {
    const r = resolveActWorkflowDispatchRepo({
      gitRemoteOriginUrl: undefined,
      packageJson: { repository: { url: "https://github.com/acme/widget.git" } },
    });
    expect(Result.isSuccess(r)).toBe(true);
    if (Result.isSuccess(r)) {
      expect(r.success).toEqual({ owner: "acme", name: "widget" });
    }
  });

  test("stringifyWorkflowDispatchEventJson adds ref, after, deleted for act github context", () => {
    const repo = { owner: "o", name: "n" };
    const json = stringifyWorkflowDispatchEventJson(repo, {
      ref: "refs/pull/1/merge",
      sha: "abcdabcdabcdabcdabcdabcdabcdabcdabcdabcd",
    });
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.deleted).toBe(false);
    expect(parsed.after).toBe("abcdabcdabcdabcdabcdabcdabcdabcdabcdabcd");
    expect(parsed.ref).toBe("refs/pull/1/merge");
    expect(parsed.act_local_ci).toBe(true);
    expect(parsed.repository).toEqual({
      name: "n",
      full_name: "o/n",
      owner: { login: "o" },
      default_branch: "main",
    });
  });

  test("stringifyWorkflowDispatchEventJson respects defaultBranch option", () => {
    const repo = { owner: "o", name: "n" };
    const json = stringifyWorkflowDispatchEventJson(repo, undefined, { defaultBranch: "develop" });
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect((parsed.repository as { default_branch: string }).default_branch).toBe("develop");
    expect(parsed.act_local_ci).toBe(true);
  });

  test("buildActArgv uses runsOnLabel as act -P key (not tied to a single OS name)", () => {
    const argv = buildActArgv({
      repoRoot: "/repo",
      runsOnLabel: "my-custom-runner",
      runnerImage: "registry.example/runner:v1",
      workflowPath: ".github/workflows/ci.yml",
      jobName: "check",
      dryRun: false,
      eventFile: undefined,
    });
    expect(argv[0]).toBe("-Pmy-custom-runner=registry.example/runner:v1");
  });

  test("buildActArgv wires platform, workflow_dispatch, job, dryrun", () => {
    const argv = buildActArgv({
      repoRoot: "/repo",
      runsOnLabel: "ubuntu-24.04",
      runnerImage: "ghcr.io/catthehacker/ubuntu:full-24.04",
      workflowPath: ".github/workflows/ci.yml",
      jobName: "check",
      dryRun: true,
      eventFile: "/repo/.act-artifacts/workflow_dispatch.json",
    });
    expect(argv).toEqual([
      "-Pubuntu-24.04=ghcr.io/catthehacker/ubuntu:full-24.04",
      "-e",
      "/repo/.act-artifacts/workflow_dispatch.json",
      "--artifact-server-path=/repo/.act-artifacts",
      "--dryrun",
      "-W",
      ".github/workflows/ci.yml",
      CI_EVENT,
      "-j",
      "check",
    ]);
  });

  test("buildActArgv passes artifact server addr/port when set", () => {
    const argv = buildActArgv({
      repoRoot: "/repo",
      runsOnLabel: "ubuntu-24.04",
      runnerImage: "img:tag",
      workflowPath: ".github/workflows/ci.yml",
      jobName: "check",
      dryRun: false,
      eventFile: undefined,
      artifactServerAddr: "127.0.0.1",
      artifactServerPort: "0",
    });
    expect(argv).toEqual([
      "-Pubuntu-24.04=img:tag",
      "--artifact-server-path=/repo/.act-artifacts",
      "--artifact-server-addr=127.0.0.1",
      "--artifact-server-port=0",
      "-W",
      ".github/workflows/ci.yml",
      CI_EVENT,
      "-j",
      "check",
    ]);
  });

  test("resolveActArtifactServerOpts omits port by default and allows omit via -", () => {
    expect(resolveActArtifactServerOpts({})).toEqual({});
    expect(
      resolveActArtifactServerOpts({
        ACT_ARTIFACT_SERVER_PORT: "34567",
      }),
    ).toEqual({ artifactServerPort: "34567" });
    expect(
      resolveActArtifactServerOpts({
        ACT_ARTIFACT_SERVER_ADDR: " 192.168.1.1 ",
        ACT_ARTIFACT_SERVER_PORT: "-",
      }),
    ).toEqual({ artifactServerAddr: "192.168.1.1" });
  });

  test("buildActArgv omits -j when jobName unset (integration workflow)", () => {
    const argv = buildActArgv({
      repoRoot: "/repo",
      runsOnLabel: "ubuntu-24.04",
      runnerImage: "img:tag",
      workflowPath: ".github/workflows/integration.yml",
      dryRun: false,
      eventFile: undefined,
    });
    expect(argv).toContain("-W");
    expect(argv).toContain(".github/workflows/integration.yml");
    expect(argv).not.toContain("-j");
    expect(argv).toContain("AUTO_PR_ACT_LOCAL_CI=1");
  });

  test("buildActArgv passes container-options when set", () => {
    const argv = buildActArgv({
      repoRoot: "/repo",
      runsOnLabel: "ubuntu-24.04",
      runnerImage: "img:tag",
      workflowPath: ".github/workflows/integration.yml",
      dryRun: false,
      eventFile: undefined,
      containerOptions: "--group-add 998",
    });
    const i = argv.indexOf("--container-options");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe("--group-add 998");
    expect(argv).toContain("AUTO_PR_ACT_LOCAL_CI=1");
  });

  test("planActRun uses bash direct act helper or gh", () => {
    const argv = ["-P", "x"] as const;
    expect(planActRun("direct", "/repo", argv)).toEqual({
      command: "bash",
      args: ["/repo/scripts/nix-run-if-missing.sh", "act", "-P", "x"],
      cwd: "/repo",
    });
    expect(planActRun("gh", "/repo", argv)).toEqual({
      command: "gh",
      args: ["act", "-P", "x"],
      cwd: "/repo",
    });
  });
});

describe("act-local-ci", () => {
  describe("mergeActContainerOptions", () => {
    test("ACT_CONTAINER_OPTIONS overrides when non-empty", () => {
      expect(
        mergeActContainerOptions({
          ACT_CONTAINER_OPTIONS: "  --privileged  ",
        }),
      ).toBe("--privileged");
    });

    test("ACT_SKIP_AUTO_DOCKER_GROUP_ADD=1 yields undefined", () => {
      expect(mergeActContainerOptions({ ACT_SKIP_AUTO_DOCKER_GROUP_ADD: "1" })).toBeUndefined();
    });
  });

  describe("CLI", () => {
    test("invalid mode fails parse (failure exit)", async () => {
      const exit = await Effect.runPromise(runCli(["bogus"]).pipe(Effect.exit));
      expect(Exit.isFailure(exit)).toBe(true);
      const pretty = Exit.match(exit, {
        onSuccess: () => "",
        onFailure: (cause) => Cause.pretty(cause),
      });
      expect(pretty.length).toBeGreaterThan(0);
    });
  });

  describe("program", () => {
    test("check + dryRun invokes direct backend with act argv (platform, -e, --dryrun, job)", async () => {
      const prevSkip = process.env.ACT_SKIP_AUTO_DOCKER_GROUP_ADD;
      process.env.ACT_SKIP_AUTO_DOCKER_GROUP_ADD = "1";
      const invocations: Array<{ command: string; args: readonly string[] }> = [];
      const layer = Layer.mergeAll(
        childProcessSpawnerCaptureExit0(invocations),
        AutoPrPlatformLayer,
      );
      try {
        await Effect.runPromise(
          program({ dryRun: true, mode: "check" }, repoRoot, {
            resolveActBackend: () => Option.some("direct"),
          }).pipe(Effect.provide(layer)),
        );
      } finally {
        if (prevSkip === undefined) delete process.env.ACT_SKIP_AUTO_DOCKER_GROUP_ADD;
        else process.env.ACT_SKIP_AUTO_DOCKER_GROUP_ADD = prevSkip;
      }
      expect(invocations.length).toBe(1);
      const first = invocations[0];
      expect(first).toBeDefined();
      if (first === undefined) return;
      const { command, args } = first;
      expect(command).toBe("bash");
      expect(args[0]).toContain("nix-run-if-missing.sh");
      expect(args[1]).toBe("act");
      const actArgv = args.slice(2);
      const expected = resolveActLocalCiRunnerFromProcessEnv(process.env, {
        mode: "check",
        dryRun: true,
      });
      expect(actArgv[0]).toBe(`-P${expected.runsOnLabel}=${expected.runnerImage}`);
      expect(actArgv).toContain("--dryrun");
      expect(actArgv).toContain("-W");
      expect(actArgv).toContain(CI_WORKFLOW);
      expect(actArgv).toContain(CI_EVENT);
      expect(actArgv).toContain("-j");
      expect(actArgv).toContain("check");
      const eIdx = actArgv.indexOf("-e");
      expect(eIdx).toBeGreaterThanOrEqual(0);
      expect(actArgv[eIdx + 1]).toBe(join(repoRoot, ACT_GENERATED_EVENT_RELATIVE_PATH));
      expect(actArgv.some((a) => a.startsWith("--artifact-server-path="))).toBe(true);
      expect(actArgv).not.toContain("AUTO_PR_ACT_LOCAL_CI=1");
    });

    test("check + dryRun invokes gh backend with gh act argv", async () => {
      const prevSkip = process.env.ACT_SKIP_AUTO_DOCKER_GROUP_ADD;
      process.env.ACT_SKIP_AUTO_DOCKER_GROUP_ADD = "1";
      const invocations: Array<{ command: string; args: readonly string[] }> = [];
      const layer = Layer.mergeAll(
        childProcessSpawnerCaptureExit0(invocations),
        AutoPrPlatformLayer,
      );
      try {
        await Effect.runPromise(
          program({ dryRun: true, mode: "check" }, repoRoot, {
            resolveActBackend: () => Option.some("gh"),
          }).pipe(Effect.provide(layer)),
        );
      } finally {
        if (prevSkip === undefined) delete process.env.ACT_SKIP_AUTO_DOCKER_GROUP_ADD;
        else process.env.ACT_SKIP_AUTO_DOCKER_GROUP_ADD = prevSkip;
      }
      expect(invocations.length).toBe(1);
      const first = invocations[0];
      expect(first).toBeDefined();
      if (first === undefined) return;
      const { command, args } = first;
      expect(command).toBe("gh");
      expect(args[0]).toBe("act");
      const actArgv = args.slice(1);
      const expected = resolveActLocalCiRunnerFromProcessEnv(process.env, {
        mode: "check",
        dryRun: true,
      });
      expect(actArgv[0]).toBe(`-P${expected.runsOnLabel}=${expected.runnerImage}`);
      expect(actArgv).toContain("--dryrun");
      expect(actArgv).toContain(CI_WORKFLOW);
      expect(actArgv).not.toContain("AUTO_PR_ACT_LOCAL_CI=1");
    });
  });
});
