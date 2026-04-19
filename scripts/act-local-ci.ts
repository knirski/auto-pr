#!/usr/bin/env bun
/**
 * Run CI `check` then `integration` jobs locally via act or gh act. Requires Docker.
 * Effect CLI (`effect/unstable/cli`) + `ChildProcess` for inherit stdio; pure helpers in #core/act-local-ci.
 * Writes `.act-artifacts/workflow_dispatch.json` for `act -e` (repo from `git remote origin` or package.json `repository`).
 *
 * From package.json: `bun run act -- <mode>` — the `--` forwards args to this script (not to `bun run`).
 * Example: `bun run act -- check`. Or run the file directly: `bun scripts/act-local-ci.ts check` (no `--`).
 */

import { statSync } from "node:fs";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Match, Option, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { runMain } from "#auto-pr";
import {
	ACT_GENERATED_EVENT_RELATIVE_PATH,
	ACT_LOCAL_CI_MODES,
	type ActBackend,
	type ActLocalCiRun,
	type ActWorkflowDispatchGitPointer,
	buildActArgv,
	CI_WORKFLOW,
	CI_WORKFLOWS_ENTRY,
	INTEGRATION_WORKFLOW,
	planActRun,
	resolveActArtifactServerOpts,
	resolveActLocalCiRunnerFromProcessEnv,
	resolveActWorkflowDispatchRepo,
	stringifyWorkflowDispatchEventJson,
} from "#core/act-local-ci.js";
import { ActLocalCiError } from "#core/errors.js";
import pkg from "../package.json" with { type: "json" };

export type { ActBackend };

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
			workflowPath: CI_WORKFLOWS_ENTRY,
			jobName: "check",
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
		const failCw = `bun run act failed on job 'check' from ${CI_WORKFLOWS_ENTRY}${outcome.dryRun ? " (dry-run check-workflows)" : ""}.`;
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
			description: "Validate ci-workflows graph without full run",
		},
	]),
);

const cliProgram = Command.run(actLocalCiCommand, { version: pkg.version });

if (import.meta.main) {
	runMain(cliProgram.pipe(Effect.provide(BunServices.layer)), "act-local-ci");
}
