/**
 * Pure model for local act runs (`act-local-ci`). No Effect, no I/O — returns Result.
 * Argv is parsed only by `effect/unstable/cli` in `scripts/act-local-ci.ts`; this module holds modes + `resolveActLocalCiInput` for validation.
 */

import { Option, Predicate, Result } from "effect";
import { ActLocalCiError } from "#core/errors.js";

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
export const CI_WORKFLOWS_ENTRY = ".github/workflows/ci-workflows.yml" as const;
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

/** JSON body for `act -e` (minimal `repository` for `github.event`). */
export function stringifyWorkflowDispatchEventJson(repo: ActWorkflowDispatchRepo): string {
	const fullName = `${repo.owner}/${repo.name}`;
	return JSON.stringify({
		repository: {
			name: repo.name,
			full_name: fullName,
			owner: { login: repo.owner },
		},
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
	readonly jobName: string;
	readonly dryRun: boolean;
	readonly eventFile: string | undefined;
};

/**
 * Build argv for the act subprocess (flags after the `act` command name). {@link planActRun} then wraps them:
 * **`direct`** → `bash` + helper + `act` + these args; **`gh`** → `gh act` + these args.
 * `-P <runs-on>=<image>` maps the workflow job’s runner label to a container image (see {@link resolveActRunnerImage}).
 */
export function buildActArgv(input: BuildActArgsInput): readonly string[] {
	const platform = `-P${input.runsOnLabel}=${input.runnerImage}`;
	const artifact = `--artifact-server-path=${input.repoRoot}/.act-artifacts`;
	const dry = input.dryRun ? (["--dryrun"] as const) : ([] as const);
	const event = input.eventFile !== undefined ? (["-e", input.eventFile] as const) : ([] as const);
	return [
		platform,
		...event,
		artifact,
		...dry,
		"-W",
		input.workflowPath,
		CI_EVENT,
		"-j",
		input.jobName,
	];
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
