#!/usr/bin/env bun
/**
 * Run CI `check` then `integration` jobs locally via act or gh act. Requires Docker.
 * Effect CLI (`effect/unstable/cli`) + `ChildProcess` for inherit stdio; pure helpers are inline below.
 * Writes `.act-artifacts/workflow_dispatch.json` for `act -e` (repo from `git remote origin` or package.json `repository`).
 *
 * From package.json: `bun run act -- <mode>` — the `--` forwards args to this script (not to `bun run`).
 * Example: `bun run act -- check`. Or run the file directly: `bun scripts/act-local-ci.ts check` (no `--`).
 */

import { statSync } from "node:fs";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Match, Option, Path, Predicate, Result } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { runMain } from "#auto-pr";
import { ActLocalCiError } from "#core/errors.js";
import pkg from "../package.json" with { type: "json" };

// ─── Modes (single source of truth for CLI) ─────────────────────────────────

/** Valid positional modes for `act-local-ci` (default when omitted: `all`). */
export const ACT_LOCAL_CI_MODES = ["check", "check-workflows", "integration", "all"] as const;

export type ActLocalCiMode = (typeof ACT_LOCAL_CI_MODES)[number];

const MODE_SET = new Set<string>(ACT_LOCAL_CI_MODES);

/** True if `s` is a valid {@link ActLocalCiMode} (including `all`). */
export function isActLocalCiMode(s: string): s is ActLocalCiMode {
	return MODE_SET.has(s);
}

export const CI_WORKFLOW = ".github/workflows/ci.yml" as const;
export const INTEGRATION_WORKFLOW = ".github/workflows/integration.yml" as const;
export const CI_EVENT = "workflow_dispatch" as const;

/**
 * Default `runs-on` label in this repository’s workflows. [nektos/act](https://github.com/nektos/act) `-P <label>=<image>` must use the **same** label as `runs-on` in the YAML you simulate. Override with `ACT_RUNS_ON_LABEL` when your workflows use a different label.
 */
export const DEFAULT_ACT_RUNS_ON_LABEL = "ubuntu-24.04" as const;

/** Written under repo root before act runs; passed to `act -e`. */
export const ACT_GENERATED_EVENT_RELATIVE_PATH = ".act-artifacts/workflow_dispatch.json" as const;

/** Minimal `github.event.repository` shape for local act runs. */
export type ActWorkflowDispatchRepo = {
	readonly owner: string;
	readonly name: string;
};

function stripDotGit(name: string): string {
	return name.endsWith(".git") ? name.slice(0, -".git".length) : name;
}

function githubRemoteMatch(
	match: Option.Option<RegExpMatchArray>,
): Option.Option<ActWorkflowDispatchRepo> {
	return Option.flatMap(match, (m) => {
		const owner = m[1];
		const rawName = m[2];
		if (owner === undefined || rawName === undefined) return Option.none();
		return Option.some({ owner, name: stripDotGit(rawName) });
	});
}

/**
 * Parses `owner` / `name` from a GitHub `git remote` URL or https repository URL.
 */
export function parseGithubRepoFromRemoteUrl(url: string): Option.Option<ActWorkflowDispatchRepo> {
	const u = url.trim();
	const fromHttps = githubRemoteMatch(
		Option.fromNullishOr(u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i)),
	);
	if (Option.isSome(fromHttps)) return fromHttps;
	const fromSsh = githubRemoteMatch(
		Option.fromNullishOr(u.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i)),
	);
	if (Option.isSome(fromSsh)) return fromSsh;
	return githubRemoteMatch(
		Option.fromNullishOr(u.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i)),
	);
}

/**
 * Parses `owner/name` from npm-style shorthand (e.g. `knirski/auto-pr`).
 */
export function parseGithubRepoFromShortName(s: string): Option.Option<ActWorkflowDispatchRepo> {
	const t = s.trim();
	const i = t.indexOf("/");
	if (i <= 0 || i === t.length - 1) return Option.none();
	const owner = t.slice(0, i);
	const name = stripDotGit(t.slice(i + 1));
	if (owner.length === 0 || name.length === 0) return Option.none();
	return Option.some({ owner, name });
}

function packageJsonRepositoryField(pkg: unknown): unknown {
	if (!Predicate.isObject(pkg)) return undefined;
	return "repository" in pkg ? pkg.repository : undefined;
}

/**
 * Resolves GitHub `owner` / `name` from `package.json` `repository` (string or `{ url }`).
 */
export function parseGithubRepoFromPackageJsonRepository(
	repoField: unknown,
): Option.Option<ActWorkflowDispatchRepo> {
	if (typeof repoField === "string") {
		if (repoField.includes("://")) {
			return parseGithubRepoFromRemoteUrl(repoField.replace(/^git\+/, ""));
		}
		return parseGithubRepoFromShortName(repoField);
	}
	if (Predicate.isObject(repoField) && "url" in repoField) {
		const url = repoField.url;
		if (typeof url === "string") {
			return parseGithubRepoFromRemoteUrl(url.replace(/^git\+/, ""));
		}
	}
	return Option.none();
}

/**
 * Resolves repo identity for the synthetic `workflow_dispatch` payload: `git remote get-url origin` first, then `package.json` `repository`.
 */
export function resolveActWorkflowDispatchRepo(input: {
	readonly gitRemoteOriginUrl: string | undefined;
	readonly packageJson: unknown;
}): Result.Result<ActWorkflowDispatchRepo, ActLocalCiError> {
	if (input.gitRemoteOriginUrl !== undefined) {
		const fromGit = parseGithubRepoFromRemoteUrl(input.gitRemoteOriginUrl);
		if (Option.isSome(fromGit)) return Result.succeed(fromGit.value);
	}
	const fromPkg = parseGithubRepoFromPackageJsonRepository(
		packageJsonRepositoryField(input.packageJson),
	);
	if (Option.isSome(fromPkg)) return Result.succeed(fromPkg.value);
	return Result.fail(
		new ActLocalCiError({
			reason:
				"act-local-ci: could not resolve GitHub owner/name for act event payload. Set `git remote origin` to a github.com URL or set package.json `repository` to a GitHub URL or `owner/repo`.",
		}),
	);
}

/** Optional `ref` / `after` for [nektos/act](https://github.com/nektos/act) `workflow_dispatch`: act sets `github.sha` from `after` when `deleted` is false; otherwise it falls back to local git (fragile under shallow/detached CI checkouts). */
export type ActWorkflowDispatchGitPointer = {
	readonly ref: string;
	readonly sha: string;
};

/** JSON body for `act -e` (`repository` for `github.event`; optional `ref` / `after` / `deleted` for act’s github context). */
export function stringifyWorkflowDispatchEventJson(
	repo: ActWorkflowDispatchRepo,
	gitPointer?: ActWorkflowDispatchGitPointer,
): string {
	const fullName = `${repo.owner}/${repo.name}`;
	const repository = {
		name: repo.name,
		full_name: fullName,
		owner: { login: repo.owner },
	};
	if (gitPointer === undefined) {
		return JSON.stringify({ repository });
	}
	return JSON.stringify({
		repository,
		ref: gitPointer.ref,
		after: gitPointer.sha,
		deleted: false,
	});
}

/**
 * Resolved inputs for the local act runner. Produced only from
 * `effect/unstable/cli` (`act-local-ci` command) via {@link resolveActLocalCiInput}.
 */
export type ActLocalCiRun = {
	readonly dryRun: boolean;
	readonly mode: ActLocalCiMode;
};

/**
 * Map Effect CLI config to a run plan (pure). Single source of truth for mode validation.
 */
export function resolveActLocalCiInput(
	dryRun: boolean,
	modeToken: string,
): Result.Result<ActLocalCiRun, ActLocalCiError> {
	if (!isActLocalCiMode(modeToken)) {
		return Result.fail(
			new ActLocalCiError({
				reason: `act-local-ci: invalid mode: ${modeToken}. Expected: ${ACT_LOCAL_CI_MODES.join(" | ")}`,
			}),
		);
	}
	return Result.succeed({ dryRun, mode: modeToken });
}

export type ResolveActRunnerImageArgs = {
	/** `ACT_RUNNER_IMAGE`; full container image ref for `act -P`. */
	readonly runnerImageFromEnv: string | undefined;
	readonly githubActions: boolean;
	readonly mode: ActLocalCiMode;
	readonly dryRun: boolean;
};

/**
 * Resolves the **container image** for [nektos/act](https://github.com/nektos/act) `-P <runs-on>=<image>`.
 * Defaults pair with {@link DEFAULT_ACT_RUNS_ON_LABEL}; if you change `ACT_RUNS_ON_LABEL` / workflows, set `ACT_RUNNER_IMAGE` explicitly.
 */
export function resolveActRunnerImage(input: ResolveActRunnerImageArgs): string {
	if (input.runnerImageFromEnv !== undefined) return input.runnerImageFromEnv;
	if (input.githubActions && (input.mode === "check-workflows" || input.dryRun)) {
		return "ghcr.io/catthehacker/ubuntu:act-24.04";
	}
	return "ghcr.io/catthehacker/ubuntu:full-24.04";
}

/**
 * Reads `ACT_RUNNER_IMAGE`, `ACT_RUNS_ON_LABEL`, and `GITHUB_ACTIONS` from `env` the same way the
 * `act-local-ci` script does, then returns the `runs-on` label and resolved container image for {@link buildActArgv}.
 */
export function resolveActLocalCiRunnerFromProcessEnv(
	env: NodeJS.ProcessEnv,
	input: { readonly mode: ActLocalCiMode; readonly dryRun: boolean },
): { readonly runsOnLabel: string; readonly runnerImage: string } {
	const fromRunner = env.ACT_RUNNER_IMAGE?.trim();
	const runnerImageFromEnv =
		fromRunner !== undefined && fromRunner.length > 0 ? fromRunner : undefined;
	const label = env.ACT_RUNS_ON_LABEL?.trim();
	const runsOnLabel = label !== undefined && label.length > 0 ? label : DEFAULT_ACT_RUNS_ON_LABEL;
	const runnerImage = resolveActRunnerImage({
		runnerImageFromEnv,
		githubActions: env.GITHUB_ACTIONS === "true",
		mode: input.mode,
		dryRun: input.dryRun,
	});
	return { runsOnLabel, runnerImage };
}

export type ActRunPlan = {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
};

/** `direct`: standalone `act` via repo helper script; `gh`: `gh act` extension. */
export type ActBackend = "direct" | "gh";

export type BuildActArgsInput = {
	readonly repoRoot: string;
	/** Must match `runs-on` in the workflow being simulated (see {@link DEFAULT_ACT_RUNS_ON_LABEL}). */
	readonly runsOnLabel: string;
	readonly runnerImage: string;
	readonly workflowPath: string;
	/** Act **`-j`** filter; omit to run all jobs in the workflow (`.github/workflows/integration.yml` has several parallel jobs, no `integration` job id). */
	readonly jobName?: string;
	readonly dryRun: boolean;
	readonly eventFile: string | undefined;
	/** Passed to act as `--artifact-server-addr` when set. */
	readonly artifactServerAddr?: string;
	/** Passed to act as `--artifact-server-port` when set (omit for act default, usually 34567). */
	readonly artifactServerPort?: string;
	/** Passed to act as **`--container-options`** (Docker flags for job containers; e.g. Docker-in-Docker socket access). */
	readonly containerOptions?: string;
};

/**
 * Resolves {@link BuildActArgsInput} artifact flags from `process.env` (act-local-ci host).
 * - **`ACT_ARTIFACT_SERVER_PORT`**: explicit port (e.g. **`45678`** if **34567** is busy), **`0`** at your own risk, or `-` to omit the flag (act’s built-in default, usually **34567**).
 * - **Default** when unset: **omit** `--artifact-server-port`. **Do not** default to **`0`**: nektos/act does not wire ephemeral ports to actions; artifact uploads fail with **`CreateArtifact` → `ECONNREFUSED`**. Use an explicit free port or stop the process holding **34567**.
 */
export function resolveActArtifactServerOpts(
	env: NodeJS.ProcessEnv,
): Pick<BuildActArgsInput, "artifactServerAddr" | "artifactServerPort"> {
	const addrRaw = env.ACT_ARTIFACT_SERVER_ADDR?.trim();
	const portRaw = env.ACT_ARTIFACT_SERVER_PORT?.trim();
	const addr = addrRaw !== undefined && addrRaw.length > 0 ? addrRaw : undefined;
	if (portRaw === "-") {
		return addr !== undefined ? { artifactServerAddr: addr } : {};
	}
	if (portRaw !== undefined && portRaw.length > 0) {
		return addr !== undefined
			? { artifactServerAddr: addr, artifactServerPort: portRaw }
			: { artifactServerPort: portRaw };
	}
	return addr !== undefined ? { artifactServerAddr: addr } : {};
}

/**
 * Build argv for the act subprocess (flags after the `act` command name). {@link planActRun} then wraps them:
 * **`direct`** → `bash` + helper + `act` + these args; **`gh`** → `gh act` + these args.
 * `-P <runs-on>=<image>` maps the workflow job’s runner label to a container image (see {@link resolveActRunnerImage}).
 */
export function buildActArgv(input: BuildActArgsInput): readonly string[] {
	const platform = `-P${input.runsOnLabel}=${input.runnerImage}`;
	const artifactPath = `--artifact-server-path=${input.repoRoot}/.act-artifacts`;
	const dry = input.dryRun ? (["--dryrun"] as const) : ([] as const);
	const event = input.eventFile !== undefined ? (["-e", input.eventFile] as const) : ([] as const);
	const mid: string[] = [platform, ...event, artifactPath];
	if (input.artifactServerAddr !== undefined) {
		mid.push(`--artifact-server-addr=${input.artifactServerAddr}`);
	}
	if (input.artifactServerPort !== undefined) {
		mid.push(`--artifact-server-port=${input.artifactServerPort}`);
	}
	const tail: string[] = [...mid, ...dry, "-W", input.workflowPath, CI_EVENT];
	const jn = input.jobName?.trim();
	if (jn !== undefined && jn.length > 0) {
		tail.push("-j", jn);
	}
	const co = input.containerOptions?.trim();
	if (co !== undefined && co.length > 0) {
		tail.push("--container-options", co);
	}
	/* Only integration workflow simulation: signals nested act / long LLM timeouts in integration tests. */
	if (input.workflowPath === INTEGRATION_WORKFLOW) {
		tail.push("--env", "AUTO_PR_ACT_LOCAL_CI=1");
	}
	return tail;
}

export function planActRun(
	backend: ActBackend,
	repoRoot: string,
	actArgv: readonly string[],
): ActRunPlan {
	if (backend === "direct") {
		const script = `${repoRoot}/scripts/nix-run-if-missing.sh`;
		return {
			command: "bash",
			args: [script, "act", ...actArgv],
			cwd: repoRoot,
		};
	}
	return {
		command: "gh",
		args: ["act", ...actArgv],
		cwd: repoRoot,
	};
}

const INSTALL_HINTS = `To run CI locally, install:
  - Docker: https://docs.docker.com/get-docker/
  - act:    https://github.com/nektos/act#installation
  - or Nix: nix run .#act -- ...  (act is in this flake; see CONTRIBUTING.md)
  - or gh:  gh extension install nektos/gh-act`;

function whichOnPath(cmd: string): Option.Option<string> {
	return Option.fromNullishOr(Bun.which(cmd));
}

/** Resolves `ref` / `sha` for act’s synthetic `workflow_dispatch` payload (see `stringifyWorkflowDispatchEventJson`). */
function resolveGitPointerForActEvent(
	repoRoot: string,
): Option.Option<ActWorkflowDispatchGitPointer> {
	const shaRes = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot });
	if (!shaRes.success) return Option.none();
	const sha = new TextDecoder().decode(shaRes.stdout).trim();
	if (sha.length === 0) return Option.none();

	const envRef = process.env.GITHUB_REF?.trim();
	if (envRef !== undefined && envRef.length > 0) {
		return Option.some({ ref: envRef, sha });
	}
	const symRes = Bun.spawnSync(["git", "symbolic-ref", "-q", "HEAD"], { cwd: repoRoot });
	if (symRes.success) {
		const ref = new TextDecoder().decode(symRes.stdout).trim();
		if (ref.length > 0) return Option.some({ ref, sha });
	}
	const curRes = Bun.spawnSync(["git", "branch", "--show-current"], { cwd: repoRoot });
	if (curRes.success) {
		const name = new TextDecoder().decode(curRes.stdout).trim();
		if (name.length > 0) return Option.some({ ref: `refs/heads/${name}`, sha });
	}
	return Option.some({ ref: "refs/heads/main", sha });
}

/**
 * Extra Docker flags for act job containers (see nektos/act **`--container-options`**).
 * Integration jobs may run nested `docker`; on Linux the job user must match **`/var/run/docker.sock`** group.
 *
 * - **`ACT_CONTAINER_OPTIONS`**: overrides auto (non-empty string).
 * - **`ACT_SKIP_AUTO_DOCKER_GROUP_ADD=1`**: skip Linux default **`--group-add`** using the host Docker socket GID.
 *
 * **Caveat:** auto **`--group-add`** assumes Docker’s socket is **`/var/run/docker.sock`** with a meaningful GID. Rootless Docker,
 * remote contexts, or a nonstandard socket path may not match; set **`ACT_CONTAINER_OPTIONS`** manually or **`ACT_SKIP_AUTO_DOCKER_GROUP_ADD=1`**.
 */
export function mergeActContainerOptions(env: NodeJS.ProcessEnv): string | undefined {
	const explicit = env.ACT_CONTAINER_OPTIONS?.trim();
	if (explicit !== undefined && explicit.length > 0) return explicit;
	if (env.ACT_SKIP_AUTO_DOCKER_GROUP_ADD === "1") return undefined;
	if (process.platform !== "linux") return undefined;
	try {
		const st = statSync("/var/run/docker.sock");
		return `--group-add ${String(st.gid)}`;
	} catch {
		return undefined;
	}
}

/**
 * Choose **`direct`** vs **`gh`** ({@link ActBackend}).
 * - **`direct`**: `act` is available on `PATH`, or `nix` is on `PATH` so the repo helper can resolve `act` (see `scripts/nix-run-if-missing.sh`). {@link planActRun} runs `bash` + that script + `act` + argv.
 * - **`gh`**: otherwise, if `gh act --help` succeeds, use the nektos/gh-act extension (`gh act` + argv).
 */
export function resolveActBackend(): Option.Option<ActBackend> {
	if (Option.isSome(whichOnPath("act")) || Option.isSome(whichOnPath("nix"))) {
		return Option.some("direct");
	}
	const r = Bun.spawnSync(["gh", "act", "--help"], { stderr: "ignore", stdout: "ignore" });
	return r.success ? Option.some("gh") : Option.none();
}

/** Best-effort `git remote get-url origin` for dynamic act event payload (forks). */
export function readGitRemoteOriginUrl(repoRoot: string): string | undefined {
	const r = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
		cwd: repoRoot,
		stderr: "ignore",
	});
	if (!r.success) return undefined;
	const text = new TextDecoder().decode(r.stdout).trim();
	return text.length > 0 ? text : undefined;
}

function spawnAct(
	command: string,
	args: readonly string[],
	cwd: string,
): Effect.Effect<void, ActLocalCiError, ChildProcessSpawner> {
	return Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner;
		const cmd = ChildProcess.make(command, [...args], {
			cwd,
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		const code = yield* spawner.exitCode(cmd);
		const n = code as number;
		if (n !== 0) {
			yield* Effect.fail(new ActLocalCiError({ reason: `act exited with code ${n}` }));
		}
	}).pipe(
		Effect.mapError((e) =>
			e instanceof ActLocalCiError ? e : new ActLocalCiError({ reason: String(e) }),
		),
	);
}

function runWorkflowJob(
	input: {
		readonly workflowPath: string;
		readonly jobName: string | undefined;
		readonly dryRun: boolean;
		readonly repoRoot: string;
		readonly runsOnLabel: string;
		readonly runnerImage: string;
		readonly eventFile: string | undefined;
		readonly failureIntro: string;
	},
	resolveBackend: () => Option.Option<ActBackend>,
): Effect.Effect<void, ActLocalCiError, ChildProcessSpawner> {
	return Effect.gen(function* () {
		const backendOpt = resolveBackend();
		if (Option.isNone(backendOpt)) {
			yield* Effect.fail(
				new ActLocalCiError({
					reason: `no act or nix on PATH and gh act is not available.\n${INSTALL_HINTS}`,
				}),
			);
			return;
		}
		const backend = backendOpt.value;
		const artifact = resolveActArtifactServerOpts(process.env);
		const containerOpts = mergeActContainerOptions(process.env);
		const actArgv = buildActArgv({
			repoRoot: input.repoRoot,
			runsOnLabel: input.runsOnLabel,
			runnerImage: input.runnerImage,
			workflowPath: input.workflowPath,
			...(input.jobName !== undefined && input.jobName.length > 0
				? { jobName: input.jobName }
				: {}),
			dryRun: input.dryRun,
			eventFile: input.eventFile,
			...artifact,
			...(containerOpts !== undefined ? { containerOptions: containerOpts } : {}),
		});
		const plan = planActRun(backend, input.repoRoot, actArgv);
		yield* spawnAct(plan.command, plan.args, plan.cwd).pipe(
			Effect.tapError(() =>
				Effect.sync(() => {
					process.stderr.write(`\n${input.failureIntro}\n${INSTALL_HINTS}\n`);
				}),
			),
		);
	});
}

type ActWorkflowCtx = {
	readonly dryRun: boolean;
	readonly repoRoot: string;
	readonly runsOnLabel: string;
	readonly runnerImage: string;
	readonly eventFile: string | undefined;
};

function runActCheckJob(
	ctx: ActWorkflowCtx,
	failureIntro: string,
	resolveBackend: () => Option.Option<ActBackend>,
): Effect.Effect<void, ActLocalCiError, ChildProcessSpawner> {
	return runWorkflowJob(
		{
			...ctx,
			workflowPath: CI_WORKFLOW,
			jobName: "check",
			failureIntro,
		},
		resolveBackend,
	);
}

function runActCheckWorkflowsJob(
	ctx: ActWorkflowCtx,
	failureIntro: string,
	resolveBackend: () => Option.Option<ActBackend>,
): Effect.Effect<void, ActLocalCiError, ChildProcessSpawner> {
	return runWorkflowJob(
		{
			...ctx,
			workflowPath: CI_WORKFLOW,
			jobName: "workflows-lint",
			failureIntro,
		},
		resolveBackend,
	);
}

function runActIntegrationJob(
	ctx: ActWorkflowCtx,
	failureIntro: string,
	resolveBackend: () => Option.Option<ActBackend>,
): Effect.Effect<void, ActLocalCiError, ChildProcessSpawner> {
	return runWorkflowJob(
		{
			...ctx,
			workflowPath: INTEGRATION_WORKFLOW,
			jobName: undefined,
			failureIntro,
		},
		resolveBackend,
	);
}

function runActCheckThenIntegration(
	ctx: ActWorkflowCtx,
	failCheck: string,
	failInt: string,
	resolveBackend: () => Option.Option<ActBackend>,
): Effect.Effect<void, ActLocalCiError, ChildProcessSpawner> {
	return Effect.gen(function* () {
		yield* runActCheckJob(ctx, failCheck, resolveBackend);
		yield* runActIntegrationJob(ctx, failInt, resolveBackend);
	});
}

/** Optional overrides for tests (e.g. inject `resolveActBackend`). */
export type ActLocalCiProgramOptions = {
	readonly resolveActBackend?: () => Option.Option<ActBackend>;
};

export function program(
	outcome: ActLocalCiRun,
	repoRoot: string,
	options?: ActLocalCiProgramOptions,
): Effect.Effect<
	void,
	ActLocalCiError | PlatformError,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> {
	const { runsOnLabel, runnerImage } = resolveActLocalCiRunnerFromProcessEnv(process.env, {
		mode: outcome.mode,
		dryRun: outcome.dryRun,
	});

	return Effect.gen(function* () {
		const resolveBackend = options?.resolveActBackend ?? resolveActBackend;
		const fs = yield* FileSystem.FileSystem;
		const pathApi = yield* Path.Path;
		yield* fs.makeDirectory(pathApi.join(repoRoot, ".act-artifacts"), { recursive: true });

		const resolvedRepo = yield* Effect.fromResult(
			resolveActWorkflowDispatchRepo({
				gitRemoteOriginUrl: readGitRemoteOriginUrl(repoRoot),
				packageJson: pkg,
			}),
		);
		const eventPath = pathApi.join(repoRoot, ACT_GENERATED_EVENT_RELATIVE_PATH);
		const gitPointer = resolveGitPointerForActEvent(repoRoot);
		yield* fs.writeFileString(
			eventPath,
			stringifyWorkflowDispatchEventJson(resolvedRepo, Option.getOrUndefined(gitPointer)),
		);
		const eventFile = eventPath;

		const ctx = {
			dryRun: outcome.dryRun,
			repoRoot,
			runsOnLabel,
			runnerImage,
			eventFile,
		} as const;

		const failCheck = `bun run act failed on job 'check' from ${CI_WORKFLOW}${outcome.dryRun ? " (dry-run check)" : ""}.`;
		const failCw = `bun run act failed on job 'workflows-lint' from ${CI_WORKFLOW}${outcome.dryRun ? " (dry-run check-workflows)" : ""}.`;
		const failInt = `bun run act failed on job 'integration' from ${INTEGRATION_WORKFLOW}${outcome.dryRun ? " (dry-run integration)" : ""}. Integration runs llama-server + GitHub Models; ensure Docker has enough resources.`;

		yield* Match.value(outcome.mode).pipe(
			Match.when("check", () => runActCheckJob(ctx, failCheck, resolveBackend)),
			Match.when("check-workflows", () => runActCheckWorkflowsJob(ctx, failCw, resolveBackend)),
			Match.when("integration", () => runActIntegrationJob(ctx, failInt, resolveBackend)),
			Match.when("all", () => runActCheckThenIntegration(ctx, failCheck, failInt, resolveBackend)),
			Match.exhaustive,
		);
	});
}

const dryRunFlag = Flag.boolean("dry-run").pipe(
	Flag.withAlias("n"),
	Flag.optional,
	Flag.withDescription("Pass act --dryrun (validate workflow graph without a full run)."),
);

const modeArg = Argument.choice("mode", [...ACT_LOCAL_CI_MODES]).pipe(
	Argument.withDefault("all"),
	Argument.withDescription(
		"check | check-workflows | integration | all (default: all — run check then integration).",
	),
);

export const actLocalCiCommand = Command.make(
	"act-local-ci",
	{
		dryRun: dryRunFlag,
		mode: modeArg,
	},
	Effect.fn("act-local-ci.handler")(function* ({ dryRun, mode }) {
		const dry = Option.getOrElse(dryRun, () => false);
		const pathApi = yield* Path.Path;
		const scriptPath = yield* pathApi.fromFileUrl(new URL(import.meta.url));
		const repoRoot = pathApi.join(pathApi.dirname(scriptPath), "..");
		// BunServices.layer: ChildProcessSpawner + FS/Path + Stdio/Terminal (Command.run needs Stdio).
		yield* program({ dryRun: dry, mode }, repoRoot).pipe(Effect.provide(BunServices.layer));
	}),
).pipe(
	Command.withDescription(
		"Run CI check / integration jobs locally via act or gh act (Docker). See CONTRIBUTING.md.",
	),
	Command.withExamples([
		{ command: "act-local-ci", description: "Run check job then integration (default mode all)" },
		{ command: "act-local-ci check", description: "CI check job only" },
		{
			command: "act-local-ci --dry-run check-workflows",
			description: "Validate ci.yml workflows-lint graph without full run",
		},
	]),
);

const cliProgram = Command.run(actLocalCiCommand, { version: pkg.version });

if (import.meta.main) {
	runMain(cliProgram.pipe(Effect.provide(BunServices.layer)), "act-local-ci");
}
