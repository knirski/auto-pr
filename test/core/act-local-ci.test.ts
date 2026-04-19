import { expect, test } from "bun:test";
import { Option, Result } from "effect";
import {
	buildActArgv,
	CI_EVENT,
	isActLocalCiMode,
	parseGithubRepoFromPackageJsonRepository,
	parseGithubRepoFromRemoteUrl,
	parseGithubRepoFromShortName,
	planActRun,
	resolveActArtifactServerOpts,
	resolveActLocalCiInput,
	resolveActRunnerImage,
	resolveActWorkflowDispatchRepo,
} from "#core/act-local-ci.js";
import { ActLocalCiError } from "#core/errors.js";

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
