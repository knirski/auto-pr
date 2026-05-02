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
 * | DEFAULT_BRANCH | ✓ | GeneratePrContent, CreateOrUpdatePr, RunAutoPr | Base branch (e.g. main) |
 * | GITHUB_WORKSPACE | ✓ | All | Repo root path |
 * | BRANCH | ✓* | GeneratePrContent, CreateOrUpdatePr | Current branch (*optional in RunAutoPr) |
 * | GH_TOKEN | ✓* | GeneratePrContent, CreateOrUpdatePr, RunAutoPr | GitHub token (*required for github-models) |
 * | AUTO_PR_AI_PROVIDER | | GeneratePrContent, RunAutoPr | local \| github-models (default: local) |
 * | AUTO_PR_AI_OPENAI_COMPAT_URL | | GeneratePrContent, RunAutoPr | OpenAI-compatible base URL when provider=local (default: http://127.0.0.1:8080/v1; e.g. llama.cpp `llama-server`) |
 * | AUTO_PR_AI_OPENAI_COMPAT_API_KEY | | GeneratePrContent, RunAutoPr | Optional API key when provider=local |
 * | AUTO_PR_AI_OPENAI_COMPAT_MODEL | | GeneratePrContent, RunAutoPr | Model id: `local` defaults to gpt-oss when unset; `github-models` defaults to microsoft/phi-4-mini-instruct when unset (lowest GitHub Models billing multipliers; see docs) |
 * | AUTO_PR_ROUTING_CONTEXT | | GeneratePrContent, RunAutoPr | Optional trusted routing context (change analysis, review focus, tool guidance, and model route) injected into the AI prompt. |
 * | AUTO_PR_EXISTING_PR_TITLE | | GeneratePrContent, RunAutoPr | Optional. When non-empty, passed into the AI prompt as the current PR title instead of resolving the open PR title. For tests or custom CI. |
 * | GITHUB_API_URL | | GeneratePrContent, CreateOrUpdatePr, RunAutoPr | Optional Octokit REST base URL (advanced; overrides GH_HOST mapping). |
 * | GH_HOST | | GeneratePrContent, CreateOrUpdatePr, RunAutoPr | Optional GitHub host. `github.com` maps to api.github.com; other hosts map to `https://<host>/api/v3`. |
 * | NO_COLOR | | — | Disable ANSI colors (read in shell.ts) |
 * | AUTO_PR_DEBUG | | — | 1 or true for verbose errors (read in shell.ts) |
 *
 * **Convention (not env):** `generate-content` uses `GitContext` with `DEFAULT_BRANCH` and `BRANCH` to fetch commit log and diff data directly. It writes `{GITHUB_WORKSPACE}/pr-title.txt` and `{GITHUB_WORKSPACE}/pr-body.md`. `create-or-update-pr` reads those paths (after `generate-content` or after restoring the artifact that copies them into the workspace). PR template: `{GITHUB_WORKSPACE}/.github/PULL_REQUEST_TEMPLATE.md` (see ADR 0008).
 * Edit that file for project-specific "how to test" steps (static markdown; not filled from code).
 */

import type { Redacted } from "effect";
import {
	Config,
	Context,
	Effect,
	FileSystem,
	Layer,
	Match,
	Option,
	Redacted as RedactedValue,
} from "effect";
import { PR_BODY_FILE_NAME, PR_TITLE_FILE_NAME } from "#auto-pr/paths.js";
import { AutoPrConfigError } from "#core/errors.js";
import { parseOpenAiCompatUrl } from "#core/openai-compat-url.js";
import { nonBlankOption } from "#core/string.js";

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
	const trimmed = value.trim();
	return trimmed === ""
		? Effect.fail(new AutoPrConfigError({ missing: [`${name} must be non-empty`] }))
		: Effect.succeed(trimmed);
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

function optionalTrimmedNonEmpty(opt: Option.Option<string>): string | undefined {
	return Option.getOrUndefined(Option.flatMap(opt, nonBlankOption));
}

function joinWorkspacePath(workspace: string, fileName: string): string {
	return `${workspace.replace(/[\\/]+$/, "")}/${fileName}`;
}

/** Unwrap Option with default; log a warning when the default is used. */
function getOrDefaultLogged<T>(
	opt: Option.Option<T>,
	name: string,
	fallback: T,
): Effect.Effect<T, never> {
	return Option.match(opt, {
		onNone: () =>
			Effect.logWarning(`${name} not set, defaulting to ${String(fallback)}`).pipe(
				Effect.as(fallback),
			),
		onSome: Effect.succeed,
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

// ─── GeneratePrContentConfig ─────────────────────────────────────────────────

export type AiProvider = "local" | "github-models";

/** Default OpenAI-compatible base URL (e.g. local llama.cpp `llama-server` `/v1`). */
export const DEFAULT_OPENAI_COMPAT_URL = "http://127.0.0.1:8080/v1";

/** Default model id when `AUTO_PR_AI_OPENAI_COMPAT_MODEL` is unset and provider is `local`. */
export const DEFAULT_OPENAI_COMPAT_MODEL = "gpt-oss";

/**
 * Default model id when `AUTO_PR_AI_OPENAI_COMPAT_MODEL` is unset and provider is `github-models`.
 * Picks a catalog model with the lowest billing multipliers (GitHub: "Costs and multipliers for using GitHub Models directly").
 */
export const DEFAULT_GITHUB_MODELS_MODEL = "microsoft/phi-4-mini-instruct";

export type GeneratePrContentConfigCommon = {
	readonly workspace: string;
	readonly templatePath: string;
	readonly defaultBranch: string;
	readonly branch: string;
	readonly model: string;
	readonly routingContext?: string;
	readonly githubApiUrl?: string;
	readonly ghHost?: string;
	readonly existingPrTitle?: string;
};

export type GeneratePrContentConfigLocal = GeneratePrContentConfigCommon & {
	readonly provider: "local";
	/** OpenAI-compatible HTTP base URL; e.g. llama.cpp today. */
	readonly openaiCompatUrl: string;
	readonly openaiCompatApiKey?: Redacted.Redacted<string>;
};

export type GeneratePrContentConfigGithubModels = GeneratePrContentConfigCommon & {
	readonly provider: "github-models";
	readonly ghToken: Redacted.Redacted<string>;
};

export type GeneratePrContentConfig =
	| GeneratePrContentConfigLocal
	| GeneratePrContentConfigGithubModels;

export const GeneratePrContentConfig =
	Context.Service<GeneratePrContentConfig>("GeneratePrContentConfig");

const DEFAULT_AI_PROVIDER: AiProvider = "local";

const GeneratePrContentConfigDef = Config.all({
	workspace: Config.string("GITHUB_WORKSPACE"),
	defaultBranch: Config.string("DEFAULT_BRANCH"),
	branch: Config.string("BRANCH"),
	aiProvider: Config.option(Config.string("AUTO_PR_AI_PROVIDER")),
	ghToken: Config.option(Config.redacted("GH_TOKEN")),
	aiOpenaiCompatUrl: Config.option(Config.string("AUTO_PR_AI_OPENAI_COMPAT_URL")),
	aiOpenaiCompatApiKey: Config.option(Config.redacted("AUTO_PR_AI_OPENAI_COMPAT_API_KEY")),
	aiOpenaiCompatModel: Config.option(Config.string("AUTO_PR_AI_OPENAI_COMPAT_MODEL")),
	githubApiUrl: Config.option(Config.string("GITHUB_API_URL")),
	ghHost: Config.option(Config.string("GH_HOST")),
	existingPrTitle: Config.option(Config.string("AUTO_PR_EXISTING_PR_TITLE")),
	routingContext: Config.option(Config.string("AUTO_PR_ROUTING_CONTEXT")),
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

function resolveProviderModel(input: {
	readonly provider: AiProvider;
	readonly aiOpenaiCompatModel: Option.Option<string>;
}): Effect.Effect<string, AutoPrConfigError, never> {
	const defaultModel =
		input.provider === "github-models" ? DEFAULT_GITHUB_MODELS_MODEL : DEFAULT_OPENAI_COMPAT_MODEL;
	return Effect.gen(function* () {
		const model = yield* getOrDefaultLogged(
			input.aiOpenaiCompatModel,
			"AUTO_PR_AI_OPENAI_COMPAT_MODEL",
			defaultModel,
		);
		return yield* requireNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_MODEL", model);
	});
}

export const GeneratePrContentConfigLayer = Layer.effect(
	GeneratePrContentConfig,
	mapConfigError(
		Effect.gen(function* () {
			const base = yield* GeneratePrContentConfigDef;
			const workspace = yield* requireNonEmpty("GITHUB_WORKSPACE", base.workspace);
			const defaultBranch = yield* requireNonEmpty("DEFAULT_BRANCH", base.defaultBranch);
			const branch = yield* requireNonEmpty("BRANCH", base.branch);
			if (branch === defaultBranch) {
				return yield* Effect.fail(
					new AutoPrConfigError({
						missing: [`BRANCH (${branch}) must differ from DEFAULT_BRANCH (${defaultBranch})`],
					}),
				);
			}
			const templatePath = joinWorkspacePath(workspace, ".github/PULL_REQUEST_TEMPLATE.md");

			const providerRaw = yield* getOrDefaultLogged(
				base.aiProvider,
				"AUTO_PR_AI_PROVIDER",
				DEFAULT_AI_PROVIDER,
			);
			const provider = yield* parseProviderOrDefault(providerRaw);
			const existingPrTitle = optionalTrimmedNonEmpty(base.existingPrTitle);
			const routingContext = optionalTrimmedNonEmpty(base.routingContext);
			const githubApiUrl = optionalTrimmedNonEmpty(base.githubApiUrl);
			const ghHost = optionalTrimmedNonEmpty(base.ghHost);

			const shared = {
				workspace,
				templatePath,
				defaultBranch,
				branch,
				...(githubApiUrl !== undefined ? { githubApiUrl } : {}),
				...(ghHost !== undefined ? { ghHost } : {}),
				...(existingPrTitle !== undefined ? { existingPrTitle } : {}),
				...(routingContext !== undefined ? { routingContext } : {}),
			};

			return yield* Match.value(provider).pipe(
				Match.when("local", () =>
					Effect.gen(function* () {
						const openaiCompatUrl = yield* getOrDefaultLogged(
							base.aiOpenaiCompatUrl,
							"AUTO_PR_AI_OPENAI_COMPAT_URL",
							DEFAULT_OPENAI_COMPAT_URL,
						);
						const urlRaw = yield* requireNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_URL", openaiCompatUrl);
						const url = yield* Effect.fromResult(parseOpenAiCompatUrl(urlRaw)).pipe(
							Effect.mapError(
								(e) =>
									new AutoPrConfigError({
										missing: [`AUTO_PR_AI_OPENAI_COMPAT_URL: ${e.reason}`],
									}),
							),
						);
						const modelId = yield* resolveProviderModel({
							provider,
							aiOpenaiCompatModel: base.aiOpenaiCompatModel,
						});
						const generatePrContentLocal: GeneratePrContentConfigLocal = {
							...shared,
							provider: "local",
							model: modelId,
							openaiCompatUrl: url,
							...(Option.isSome(base.aiOpenaiCompatApiKey)
								? { openaiCompatApiKey: base.aiOpenaiCompatApiKey.value }
								: {}),
						};
						return generatePrContentLocal;
					}),
				),
				Match.when("github-models", () =>
					Effect.gen(function* () {
						const ghToken = yield* requireRedactedOption(
							"GH_TOKEN",
							base.ghToken,
							"GH_TOKEN required for github-models",
						);
						const modelId = yield* resolveProviderModel({
							provider,
							aiOpenaiCompatModel: base.aiOpenaiCompatModel,
						});
						const generatePrContentGithub: GeneratePrContentConfigGithubModels = {
							...shared,
							provider: "github-models",
							model: modelId,
							ghToken,
						};
						return generatePrContentGithub;
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
	readonly githubApiUrl?: string;
	readonly ghHost?: string;
}

export const CreateOrUpdatePrConfig =
	Context.Service<CreateOrUpdatePrConfig>("CreateOrUpdatePrConfig");

const CreateOrUpdatePrConfigDef = Config.all({
	branch: Config.string("BRANCH"),
	defaultBranch: Config.string("DEFAULT_BRANCH"),
	workspace: Config.string("GITHUB_WORKSPACE"),
	ghToken: Config.redacted("GH_TOKEN"),
	githubApiUrl: Config.option(Config.string("GITHUB_API_URL")),
	ghHost: Config.option(Config.string("GH_HOST")),
});

export const CreateOrUpdatePrConfigLayer = Layer.effect(
	CreateOrUpdatePrConfig,
	mapConfigError(
		Effect.gen(function* () {
			const base = yield* CreateOrUpdatePrConfigDef;
			const branch = yield* requireNonEmpty("BRANCH", base.branch);
			const defaultBranch = yield* requireNonEmpty("DEFAULT_BRANCH", base.defaultBranch);
			const workspace = yield* requireNonEmpty("GITHUB_WORKSPACE", base.workspace);
			const githubApiUrl = optionalTrimmedNonEmpty(base.githubApiUrl);
			const ghHost = optionalTrimmedNonEmpty(base.ghHost);
			const fs = yield* FileSystem.FileSystem;
			const titlePath = joinWorkspacePath(workspace, PR_TITLE_FILE_NAME);
			const bodyFile = joinWorkspacePath(workspace, PR_BODY_FILE_NAME);
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
				...(githubApiUrl !== undefined ? { githubApiUrl } : {}),
				...(ghHost !== undefined ? { ghHost } : {}),
			};
		}),
	),
);

// ─── RunAutoPrConfig (local pipeline) ─────────────────────────────────────────

/**
 * Shared fields for `run-auto-pr` config; discriminated by {@link RunAutoPrConfigLocal} vs {@link RunAutoPrConfigGithubModels}.
 *
 * Optional fields follow the same convention as {@link GeneratePrContentConfig}: `Config.option` + `Option` only inside
 * {@link RunAutoPrConfigLayer}; the service shape uses `?:` (omit when unset), not `Option` in the type.
 */
export type RunAutoPrConfigCommon = {
	readonly defaultBranch: string;
	readonly workspace: string;
	readonly templatePath: string;
	readonly ghToken: Redacted.Redacted<string>;
	readonly model: string;
	readonly routingContext?: string;
	readonly githubApiUrl?: string;
	readonly ghHost?: string;
	/** When set from `BRANCH`; omit to resolve the head branch via `git branch --show-current` at run time. */
	readonly branch?: string;
	readonly existingPrTitle?: string;
};

export type RunAutoPrConfigLocal = RunAutoPrConfigCommon & {
	readonly provider: "local";
	readonly openaiCompatUrl: string;
	/** When set from `AUTO_PR_AI_OPENAI_COMPAT_API_KEY`. */
	readonly openaiCompatApiKey?: Redacted.Redacted<string>;
};

export type RunAutoPrConfigGithubModels = RunAutoPrConfigCommon & {
	readonly provider: "github-models";
};

/** `run-auto-pr` config: OpenAI-compat fields exist only when `provider` is `local`. */
export type RunAutoPrConfig = RunAutoPrConfigLocal | RunAutoPrConfigGithubModels;

export const RunAutoPrConfig = Context.Service<RunAutoPrConfig>("RunAutoPrConfig");

const RunAutoPrConfigDef = Config.all({
	defaultBranch: Config.string("DEFAULT_BRANCH"),
	workspace: Config.string("GITHUB_WORKSPACE"),
	ghToken: Config.redacted("GH_TOKEN"),
	aiProvider: Config.option(Config.string("AUTO_PR_AI_PROVIDER")),
	aiOpenaiCompatUrl: Config.option(Config.string("AUTO_PR_AI_OPENAI_COMPAT_URL")),
	aiOpenaiCompatApiKey: Config.option(Config.redacted("AUTO_PR_AI_OPENAI_COMPAT_API_KEY")),
	aiOpenaiCompatModel: Config.option(Config.string("AUTO_PR_AI_OPENAI_COMPAT_MODEL")),
	githubApiUrl: Config.option(Config.string("GITHUB_API_URL")),
	ghHost: Config.option(Config.string("GH_HOST")),
	branch: Config.option(Config.string("BRANCH")),
	existingPrTitle: Config.option(Config.string("AUTO_PR_EXISTING_PR_TITLE")),
	routingContext: Config.option(Config.string("AUTO_PR_ROUTING_CONTEXT")),
});

export const RunAutoPrConfigLayer = Layer.effect(
	RunAutoPrConfig,
	mapConfigError(
		Effect.gen(function* () {
			const base = yield* RunAutoPrConfigDef;
			const defaultBranch = yield* requireNonEmpty("DEFAULT_BRANCH", base.defaultBranch);
			const workspace = yield* requireNonEmpty("GITHUB_WORKSPACE", base.workspace);
			const templatePath = joinWorkspacePath(workspace, ".github/PULL_REQUEST_TEMPLATE.md");

			const branch = optionalTrimmedNonEmpty(base.branch);
			const githubApiUrl = optionalTrimmedNonEmpty(base.githubApiUrl);
			const ghHost = optionalTrimmedNonEmpty(base.ghHost);

			if (branch === defaultBranch) {
				return yield* Effect.fail(
					new AutoPrConfigError({
						missing: [`BRANCH (${branch}) must differ from DEFAULT_BRANCH (${defaultBranch})`],
					}),
				);
			}

			const providerRaw = yield* getOrDefaultLogged(
				base.aiProvider,
				"AUTO_PR_AI_PROVIDER",
				DEFAULT_AI_PROVIDER,
			);
			const provider = yield* parseProviderOrDefault(providerRaw);
			const existingPrTitle = optionalTrimmedNonEmpty(base.existingPrTitle);
			const routingContext = optionalTrimmedNonEmpty(base.routingContext);

			const shared = {
				defaultBranch,
				workspace,
				templatePath,
				ghToken: base.ghToken,
				...(githubApiUrl !== undefined ? { githubApiUrl } : {}),
				...(ghHost !== undefined ? { ghHost } : {}),
				...(branch !== undefined ? { branch } : {}),
				...(existingPrTitle !== undefined ? { existingPrTitle } : {}),
				...(routingContext !== undefined ? { routingContext } : {}),
			};

			return yield* Match.value(provider).pipe(
				Match.when("local", () =>
					Effect.gen(function* () {
						const openaiCompatUrl = yield* getOrDefaultLogged(
							base.aiOpenaiCompatUrl,
							"AUTO_PR_AI_OPENAI_COMPAT_URL",
							DEFAULT_OPENAI_COMPAT_URL,
						);
						const urlRaw = yield* requireNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_URL", openaiCompatUrl);
						const url = yield* Effect.fromResult(parseOpenAiCompatUrl(urlRaw)).pipe(
							Effect.mapError(
								(e) =>
									new AutoPrConfigError({
										missing: [`AUTO_PR_AI_OPENAI_COMPAT_URL: ${e.reason}`],
									}),
							),
						);
						const modelId = yield* resolveProviderModel({
							provider,
							aiOpenaiCompatModel: base.aiOpenaiCompatModel,
						});
						const runAutoPrLocal: RunAutoPrConfigLocal = {
							...shared,
							provider: "local",
							model: modelId,
							openaiCompatUrl: url,
							...(Option.isSome(base.aiOpenaiCompatApiKey)
								? { openaiCompatApiKey: base.aiOpenaiCompatApiKey.value }
								: {}),
						};
						return runAutoPrLocal;
					}),
				),
				Match.when("github-models", () =>
					Effect.gen(function* () {
						const modelId = yield* resolveProviderModel({
							provider,
							aiOpenaiCompatModel: base.aiOpenaiCompatModel,
						});
						const runAutoPrGithub: RunAutoPrConfigGithubModels = {
							...shared,
							provider: "github-models",
							model: modelId,
						};
						return runAutoPrGithub;
					}),
				),
				Match.exhaustive,
			);
		}),
	),
);
