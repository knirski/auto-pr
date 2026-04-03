/**
 * Config services for auto-PR. Validate and fail early: required env vars are
 * required at load time; missing or empty vars cause immediate failure.
 * No default values for inputs.
 *
 * Each workflow has its own config with only the fields it needs. Required
 * workflow vars are non-optional; provider-specific vars use Config.option and
 * are validated when that provider is selected.
 *
 * ## All environment variables
 *
 * | Variable | Required | Config | Description |
 * |----------|----------|--------|--------------|
 * | DEFAULT_BRANCH | ✓ | GetCommits, CreateOrUpdatePr, RunAutoPr | Base branch (e.g. main) |
 * | GITHUB_WORKSPACE | ✓ | All | Repo root path |
 * | GITHUB_OUTPUT | ✓ | GetCommits | Append target for step outputs; **Actions assigns a unique path per step** (don’t reuse across steps) |
 * | BRANCH | ✓* | CreateOrUpdatePr | Current branch (*optional in RunAutoPr) |
 * | GH_TOKEN | ✓* | GeneratePrContent, CreateOrUpdatePr, RunAutoPr | GitHub token (*required for github-models) |
 * | AUTO_PR_AI_PROVIDER | | GeneratePrContent, RunAutoPr | local \| github-models (default: local) |
 * | AUTO_PR_AI_OPENAI_COMPAT_URL | | GeneratePrContent, RunAutoPr | OpenAI-compatible base URL when provider=local (default: http://127.0.0.1:8080/v1; e.g. llama.cpp `llama-server`) |
 * | AUTO_PR_AI_OPENAI_COMPAT_API_KEY | | GeneratePrContent, RunAutoPr | Optional API key when provider=local |
 * | AUTO_PR_AI_OPENAI_COMPAT_MODEL | | GeneratePrContent, RunAutoPr | Model id: `local` defaults to gpt-oss when unset; `github-models` defaults to microsoft/phi-4-mini-instruct when unset (lowest GitHub Models billing multipliers; see docs) |
 * | NO_COLOR | | — | Disable ANSI colors (read in shell.ts) |
 * | AUTO_PR_DEBUG | | — | 1 or true for verbose errors (read in shell.ts) |
 *
 * **Convention (not env):** `generate-content` reads `{GITHUB_WORKSPACE}/commits.txt` and `{GITHUB_WORKSPACE}/files.txt` (same paths `get-commits` writes). It writes `{GITHUB_WORKSPACE}/pr-title.txt` and `{GITHUB_WORKSPACE}/pr-body.md`. `create-or-update-pr` reads those paths (after `generate-content` or after restoring the artifact that copies them into the workspace). PR template: `{GITHUB_WORKSPACE}/.github/PULL_REQUEST_TEMPLATE.md` (see ADR 0008).
 * Edit that file for project-specific “how to test” steps (static markdown; not filled from code).
 */

import { join } from "node:path";
import type { Redacted } from "effect";
import {
	Config,
	Effect,
	FileSystem,
	Layer,
	Match,
	Option,
	Redacted as RedactedValue,
	ServiceMap,
} from "effect";
import { PR_BODY_FILE_NAME, PR_TITLE_FILE_NAME } from "#auto-pr/paths.js";
import { AutoPrConfigError } from "#core/errors.js";

/** Type guard for cause with message property. */
function hasMessage(obj: unknown): obj is { message?: string } {
	return obj != null && typeof obj === "object" && "message" in obj;
}

/** Pure: extract missing env messages from ConfigError. */
function extractMissingFromConfigError(e: Config.ConfigError): string[] {
	return e.cause && hasMessage(e.cause) ? [String(e.cause.message ?? e.message)] : [e.message];
}

/** Fail when value is blank. Required vars must be non-empty. */
function requireNonEmpty(
	name: string,
	value: string,
): Effect.Effect<string, AutoPrConfigError, never> {
	return value.trim() === ""
		? Effect.fail(new AutoPrConfigError({ missing: [`${name} must be non-empty`] }))
		: Effect.succeed(value);
}

function requireRedactedNonEmpty(
	name: string,
	value: Redacted.Redacted<string>,
): Effect.Effect<Redacted.Redacted<string>, AutoPrConfigError, never> {
	return RedactedValue.value(value).trim() === ""
		? Effect.fail(new AutoPrConfigError({ missing: [`${name} must be non-empty`] }))
		: Effect.succeed(value);
}

function requireRedactedOption(
	name: string,
	opt: Option.Option<Redacted.Redacted<string>>,
	missingMessage: string,
): Effect.Effect<Redacted.Redacted<string>, AutoPrConfigError, never> {
	return Option.match(opt, {
		onNone: () => Effect.fail(new AutoPrConfigError({ missing: [missingMessage] })),
		onSome: (v) => requireRedactedNonEmpty(name, v),
	});
}

function configErrorToAutoPrConfig(e: Config.ConfigError): AutoPrConfigError {
	return new AutoPrConfigError({ missing: extractMissingFromConfigError(e) });
}

function mapConfigError<A, R>(
	effect: Effect.Effect<A, Config.ConfigError | AutoPrConfigError, R>,
): Effect.Effect<A, AutoPrConfigError, R> {
	return effect.pipe(
		Effect.mapError((e) => (e instanceof AutoPrConfigError ? e : configErrorToAutoPrConfig(e))),
	);
}

// ─── GetCommitsConfig ────────────────────────────────────────────────────────

export interface GetCommitsConfig {
	readonly defaultBranch: string;
	readonly workspace: string;
	readonly ghOutput: string;
}

export const GetCommitsConfig = ServiceMap.Service<GetCommitsConfig>("GetCommitsConfig");

const GetCommitsConfigDef = Config.all({
	defaultBranch: Config.string("DEFAULT_BRANCH"),
	workspace: Config.string("GITHUB_WORKSPACE"),
	ghOutput: Config.string("GITHUB_OUTPUT"),
});

export const GetCommitsConfigLayer = Layer.effect(
	GetCommitsConfig,
	mapConfigError(
		Effect.gen(function* () {
			const base = yield* GetCommitsConfigDef;
			const defaultBranch = yield* requireNonEmpty("DEFAULT_BRANCH", base.defaultBranch);
			const workspace = yield* requireNonEmpty("GITHUB_WORKSPACE", base.workspace);
			const ghOutput = yield* requireNonEmpty("GITHUB_OUTPUT", base.ghOutput);
			return { defaultBranch, workspace, ghOutput };
		}),
	),
);

// ─── GeneratePrContentConfig ─────────────────────────────────────────────────

export type AiProvider = "local" | "github-models";

/** Default OpenAI-compatible base URL (e.g. local llama.cpp `llama-server` `/v1`). */
export const DEFAULT_OPENAI_COMPAT_URL = "http://127.0.0.1:8080/v1";

/** Default model id when `AUTO_PR_AI_OPENAI_COMPAT_MODEL` is unset and provider is `local`. */
export const DEFAULT_OPENAI_COMPAT_MODEL = "gpt-oss";

/**
 * Default model id when `AUTO_PR_AI_OPENAI_COMPAT_MODEL` is unset and provider is `github-models`.
 * Picks a catalog model with the lowest billing multipliers (GitHub: “Costs and multipliers for using GitHub Models directly”).
 */
export const DEFAULT_GITHUB_MODELS_MODEL = "microsoft/phi-4-mini-instruct";

export interface GeneratePrContentConfig {
	readonly commits: string;
	readonly files: string;
	readonly workspace: string;
	readonly templatePath: string;
	readonly provider: AiProvider;
	readonly model: string;
	/** Set when `provider` is `github-models`. */
	readonly ghToken?: Redacted.Redacted<string>;
	/** Set when `provider` is `local` (OpenAI-compatible HTTP; e.g. llama.cpp today). */
	readonly openaiCompatUrl?: string;
	readonly openaiCompatApiKey?: Redacted.Redacted<string>;
}

export const GeneratePrContentConfig =
	ServiceMap.Service<GeneratePrContentConfig>("GeneratePrContentConfig");

const DEFAULT_AI_PROVIDER: AiProvider = "local";

const GeneratePrContentConfigDef = Config.all({
	workspace: Config.string("GITHUB_WORKSPACE"),
	aiProvider: Config.option(Config.string("AUTO_PR_AI_PROVIDER")),
	ghToken: Config.option(Config.redacted("GH_TOKEN")),
	aiOpenaiCompatUrl: Config.option(Config.string("AUTO_PR_AI_OPENAI_COMPAT_URL")),
	aiOpenaiCompatApiKey: Config.option(Config.redacted("AUTO_PR_AI_OPENAI_COMPAT_API_KEY")),
	aiOpenaiCompatModel: Config.option(Config.string("AUTO_PR_AI_OPENAI_COMPAT_MODEL")),
});

function parseProvider(raw: string): Effect.Effect<AiProvider, AutoPrConfigError, never> {
	const trimmed = raw.trim().toLowerCase();
	return Match.value(trimmed).pipe(
		Match.when("local", () => Effect.succeed("local" as const)),
		Match.when("github-models", () => Effect.succeed("github-models" as const)),
		Match.orElse(() =>
			Effect.fail(
				new AutoPrConfigError({
					missing: [`Invalid AUTO_PR_AI_PROVIDER: ${raw}. Must be local or github-models`],
				}),
			),
		),
	);
}

const parseProviderOrDefault = (raw: string) =>
	raw === "" ? Effect.succeed(DEFAULT_AI_PROVIDER) : parseProvider(raw);

export const GeneratePrContentConfigLayer = Layer.effect(
	GeneratePrContentConfig,
	mapConfigError(
		Effect.gen(function* () {
			const base = yield* GeneratePrContentConfigDef;
			const workspace = yield* requireNonEmpty("GITHUB_WORKSPACE", base.workspace);
			const commits = join(workspace, "commits.txt");
			const files = join(workspace, "files.txt");
			const templatePath = join(workspace, ".github/PULL_REQUEST_TEMPLATE.md");

			const providerRaw = Option.getOrElse(base.aiProvider, () => "");
			yield* Option.match(base.aiProvider, {
				onNone: () => Effect.logWarning("AUTO_PR_AI_PROVIDER not set, defaulting to local"),
				onSome: () => Effect.void,
			});
			const provider = yield* parseProviderOrDefault(providerRaw);

			const shared = {
				commits,
				files,
				workspace,
				templatePath,
				provider,
			};

			return yield* Match.value(provider).pipe(
				Match.when("local", () =>
					Effect.gen(function* () {
						const openaiCompatUrl = Option.getOrElse(
							base.aiOpenaiCompatUrl,
							() => DEFAULT_OPENAI_COMPAT_URL,
						);
						const url = yield* requireNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_URL", openaiCompatUrl);
						const model = Option.getOrElse(
							base.aiOpenaiCompatModel,
							() => DEFAULT_OPENAI_COMPAT_MODEL,
						);
						const modelId = yield* requireNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_MODEL", model);
						return {
							...shared,
							model: modelId,
							openaiCompatUrl: url,
							...(Option.isSome(base.aiOpenaiCompatApiKey)
								? { openaiCompatApiKey: base.aiOpenaiCompatApiKey.value }
								: {}),
						};
					}),
				),
				Match.when("github-models", () =>
					Effect.gen(function* () {
						const ghToken = yield* requireRedactedOption(
							"GH_TOKEN",
							base.ghToken,
							"GH_TOKEN required for github-models",
						);
						const model = Option.getOrElse(
							base.aiOpenaiCompatModel,
							() => DEFAULT_GITHUB_MODELS_MODEL,
						);
						const modelId = yield* requireNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_MODEL", model);
						return {
							...shared,
							model: modelId,
							ghToken,
						};
					}),
				),
				Match.exhaustive,
			);
		}),
	),
);

// ─── CreateOrUpdatePrConfig ──────────────────────────────────────────────────

export interface CreateOrUpdatePrConfig {
	readonly branch: string;
	readonly defaultBranch: string;
	readonly title: string;
	readonly bodyFile: string;
	readonly workspace: string;
	readonly ghToken: Redacted.Redacted<string>;
}

export const CreateOrUpdatePrConfig =
	ServiceMap.Service<CreateOrUpdatePrConfig>("CreateOrUpdatePrConfig");

const CreateOrUpdatePrConfigDef = Config.all({
	branch: Config.string("BRANCH"),
	defaultBranch: Config.string("DEFAULT_BRANCH"),
	workspace: Config.string("GITHUB_WORKSPACE"),
	ghToken: Config.redacted("GH_TOKEN"),
});

export const CreateOrUpdatePrConfigLayer = Layer.effect(
	CreateOrUpdatePrConfig,
	mapConfigError(
		Effect.gen(function* () {
			const base = yield* CreateOrUpdatePrConfigDef;
			const branch = yield* requireNonEmpty("BRANCH", base.branch);
			const defaultBranch = yield* requireNonEmpty("DEFAULT_BRANCH", base.defaultBranch);
			const workspace = yield* requireNonEmpty("GITHUB_WORKSPACE", base.workspace);
			const fs = yield* FileSystem.FileSystem;
			const titlePath = join(workspace, PR_TITLE_FILE_NAME);
			const bodyFile = join(workspace, PR_BODY_FILE_NAME);
			const titleRaw = yield* fs.readFileString(titlePath).pipe(
				Effect.mapError(
					() =>
						new AutoPrConfigError({
							missing: [
								`${PR_TITLE_FILE_NAME} at ${titlePath} (readable file required; run generate-content first)`,
							],
						}),
				),
			);
			const title = yield* requireNonEmpty(PR_TITLE_FILE_NAME, titleRaw.trim());
			return {
				branch,
				defaultBranch,
				title,
				bodyFile,
				workspace,
				ghToken: base.ghToken,
			};
		}),
	),
);

// ─── RunAutoPrConfig (local pipeline) ─────────────────────────────────────────

export interface RunAutoPrConfig {
	readonly defaultBranch: string;
	readonly workspace: string;
	readonly templatePath: string;
	readonly ghToken: Redacted.Redacted<string>;
	readonly provider: AiProvider;
	readonly model: string;
	readonly branch: string | undefined;
	/** Set when `provider` is `local`. */
	readonly openaiCompatUrl?: string;
	readonly openaiCompatApiKey?: Redacted.Redacted<string>;
}

export const RunAutoPrConfig = ServiceMap.Service<RunAutoPrConfig>("RunAutoPrConfig");

const RunAutoPrConfigDef = Config.all({
	defaultBranch: Config.string("DEFAULT_BRANCH"),
	workspace: Config.string("GITHUB_WORKSPACE"),
	ghToken: Config.redacted("GH_TOKEN"),
	aiProvider: Config.option(Config.string("AUTO_PR_AI_PROVIDER")),
	aiOpenaiCompatUrl: Config.option(Config.string("AUTO_PR_AI_OPENAI_COMPAT_URL")),
	aiOpenaiCompatApiKey: Config.option(Config.redacted("AUTO_PR_AI_OPENAI_COMPAT_API_KEY")),
	aiOpenaiCompatModel: Config.option(Config.string("AUTO_PR_AI_OPENAI_COMPAT_MODEL")),
	branch: Config.option(Config.string("BRANCH")),
});

export const RunAutoPrConfigLayer = Layer.effect(
	RunAutoPrConfig,
	mapConfigError(
		Effect.gen(function* () {
			const base = yield* RunAutoPrConfigDef;
			const defaultBranch = yield* requireNonEmpty("DEFAULT_BRANCH", base.defaultBranch);
			const workspace = yield* requireNonEmpty("GITHUB_WORKSPACE", base.workspace);
			const templatePath = join(workspace, ".github/PULL_REQUEST_TEMPLATE.md");

			const providerRaw = Option.getOrElse(base.aiProvider, () => "");
			yield* Option.match(base.aiProvider, {
				onNone: () => Effect.logWarning("AUTO_PR_AI_PROVIDER not set, defaulting to local"),
				onSome: () => Effect.void,
			});
			const provider = yield* parseProviderOrDefault(providerRaw);

			const shared = {
				defaultBranch,
				workspace,
				templatePath,
				ghToken: base.ghToken,
				provider,
				branch: Option.getOrUndefined(base.branch),
			};

			return yield* Match.value(provider).pipe(
				Match.when("local", () =>
					Effect.gen(function* () {
						const openaiCompatUrl = Option.getOrElse(
							base.aiOpenaiCompatUrl,
							() => DEFAULT_OPENAI_COMPAT_URL,
						);
						const url = yield* requireNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_URL", openaiCompatUrl);
						const model = Option.getOrElse(
							base.aiOpenaiCompatModel,
							() => DEFAULT_OPENAI_COMPAT_MODEL,
						);
						const modelId = yield* requireNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_MODEL", model);
						return {
							...shared,
							model: modelId,
							openaiCompatUrl: url,
							...(Option.isSome(base.aiOpenaiCompatApiKey)
								? { openaiCompatApiKey: base.aiOpenaiCompatApiKey.value }
								: {}),
						};
					}),
				),
				Match.when("github-models", () =>
					Effect.gen(function* () {
						const model = Option.getOrElse(
							base.aiOpenaiCompatModel,
							() => DEFAULT_GITHUB_MODELS_MODEL,
						);
						const modelId = yield* requireNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_MODEL", model);
						return {
							...shared,
							model: modelId,
						};
					}),
				),
				Match.exhaustive,
			);
		}),
	),
);
