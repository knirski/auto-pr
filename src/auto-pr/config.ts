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
 * | GITHUB_OUTPUT | ✓ | GetCommits, GeneratePrContent | Path to write outputs |
 * | COMMITS | ✓ | GeneratePrContent | Path to commits file |
 * | FILES | ✓ | GeneratePrContent | Path to changed files list |
 * | PR_TEMPLATE_PATH | ✓ | GeneratePrContent, RunAutoPr | Path to PR template |
 * | AUTO_PR_HOW_TO_TEST | ✓ | GeneratePrContent, RunAutoPr, FillPrTemplate | Default for {{howToTest}} |
 * | BRANCH | ✓* | CreateOrUpdatePr | Current branch (*optional in RunAutoPr) |
 * | TITLE | ✓ | CreateOrUpdatePr | PR title |
 * | BODY_FILE | ✓ | CreateOrUpdatePr | Path to PR body markdown |
 * | GH_TOKEN | ✓* | GeneratePrContent, CreateOrUpdatePr, RunAutoPr | GitHub token (*required for github-models) |
 * | AUTO_PR_AI_PROVIDER | | GeneratePrContent, RunAutoPr | ollama \| github-models \| openai-compat (default: ollama) |
 * | AUTO_PR_AI_OLLAMA_MODEL | | GeneratePrContent, RunAutoPr | Model when provider=ollama (default: llama3.1:8b) |
 * | AUTO_PR_AI_GITHUB_MODEL | ✓* | GeneratePrContent, RunAutoPr | Model when provider=github-models |
 * | AUTO_PR_AI_OPENAI_COMPAT_URL | ✓* | GeneratePrContent, RunAutoPr | API URL when provider=openai-compat |
 * | AUTO_PR_AI_OPENAI_COMPAT_API_KEY | ✓* | GeneratePrContent, RunAutoPr | API key when provider=openai-compat |
 * | AUTO_PR_AI_OPENAI_COMPAT_MODEL | ✓* | GeneratePrContent, RunAutoPr | Model when provider=openai-compat |
 * | NO_COLOR | | — | Disable ANSI colors (read in shell.ts) |
 * | AUTO_PR_DEBUG | | — | 1 or true for verbose errors (read in shell.ts) |
 */

import type { Redacted } from "effect";
import {
	Config,
	Effect,
	Layer,
	Match,
	Option,
	Redacted as RedactedValue,
	ServiceMap,
} from "effect";
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

function requireNonEmptyStringOption(
	name: string,
	opt: Option.Option<string>,
	missingMessage: string,
): Effect.Effect<string, AutoPrConfigError, never> {
	return Option.match(opt, {
		onNone: () => Effect.fail(new AutoPrConfigError({ missing: [missingMessage] })),
		onSome: (v) => requireNonEmpty(name, v),
	});
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

export type AiProvider = "ollama" | "github-models" | "openai-compat";

export interface GeneratePrContentConfig {
	readonly commits: string;
	readonly files: string;
	readonly ghOutput: string;
	readonly workspace: string;
	readonly templatePath: string;
	readonly provider: AiProvider;
	readonly model: string;
	readonly howToTestDefault: string;
	/** Set when `provider` is `github-models`. */
	readonly ghToken?: Redacted.Redacted<string>;
	readonly githubModel?: string;
	/** Set when `provider` is `openai-compat`. */
	readonly openaiCompatUrl?: string;
	readonly openaiCompatApiKey?: Redacted.Redacted<string>;
	readonly openaiCompatModel?: string;
}

export const GeneratePrContentConfig =
	ServiceMap.Service<GeneratePrContentConfig>("GeneratePrContentConfig");

const DEFAULT_AI_PROVIDER: AiProvider = "ollama";
const DEFAULT_OLLAMA_MODEL = "llama3.1:8b";

const GeneratePrContentConfigDef = Config.all({
	commits: Config.string("COMMITS"),
	files: Config.string("FILES"),
	ghOutput: Config.string("GITHUB_OUTPUT"),
	workspace: Config.string("GITHUB_WORKSPACE"),
	templatePath: Config.string("PR_TEMPLATE_PATH"),
	aiProvider: Config.option(Config.string("AUTO_PR_AI_PROVIDER")),
	aiOllamaModel: Config.option(Config.string("AUTO_PR_AI_OLLAMA_MODEL")),
	ghToken: Config.option(Config.redacted("GH_TOKEN")),
	aiGitHubModel: Config.option(Config.string("AUTO_PR_AI_GITHUB_MODEL")),
	aiOpenaiCompatUrl: Config.option(Config.string("AUTO_PR_AI_OPENAI_COMPAT_URL")),
	aiOpenaiCompatApiKey: Config.option(Config.redacted("AUTO_PR_AI_OPENAI_COMPAT_API_KEY")),
	aiOpenaiCompatModel: Config.option(Config.string("AUTO_PR_AI_OPENAI_COMPAT_MODEL")),
	howToTestDefault: Config.string("AUTO_PR_HOW_TO_TEST"),
});

function parseProvider(raw: string): Effect.Effect<AiProvider, AutoPrConfigError, never> {
	const trimmed = raw.trim().toLowerCase();
	return Match.value(trimmed).pipe(
		Match.when("ollama", () => Effect.succeed("ollama" as const)),
		Match.when("github-models", () => Effect.succeed("github-models" as const)),
		Match.when("openai-compat", () => Effect.succeed("openai-compat" as const)),
		Match.orElse(() =>
			Effect.fail(
				new AutoPrConfigError({
					missing: [
						`Invalid AUTO_PR_AI_PROVIDER: ${raw}. Must be ollama, github-models, or openai-compat`,
					],
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
			const commits = yield* requireNonEmpty("COMMITS", base.commits);
			const files = yield* requireNonEmpty("FILES", base.files);
			const ghOutput = yield* requireNonEmpty("GITHUB_OUTPUT", base.ghOutput);
			const workspace = yield* requireNonEmpty("GITHUB_WORKSPACE", base.workspace);
			const templatePath = yield* requireNonEmpty("PR_TEMPLATE_PATH", base.templatePath);
			const howToTestDefault = yield* requireNonEmpty("AUTO_PR_HOW_TO_TEST", base.howToTestDefault);

			const providerRaw = Option.getOrElse(base.aiProvider, () => "");
			yield* Option.match(base.aiProvider, {
				onNone: () => Effect.logWarning("AUTO_PR_AI_PROVIDER not set, defaulting to ollama"),
				onSome: () => Effect.void,
			});
			const provider = yield* parseProviderOrDefault(providerRaw);

			const shared = {
				commits,
				files,
				ghOutput,
				workspace,
				templatePath,
				provider,
				howToTestDefault,
			};

			return yield* Match.value(provider).pipe(
				Match.when("ollama", () =>
					Effect.succeed({
						...shared,
						model: Option.getOrElse(base.aiOllamaModel, () => DEFAULT_OLLAMA_MODEL),
					}),
				),
				Match.when("github-models", () =>
					Effect.gen(function* () {
						const ghToken = yield* requireRedactedOption(
							"GH_TOKEN",
							base.ghToken,
							"GH_TOKEN required for github-models",
						);
						const githubModel = yield* requireNonEmptyStringOption(
							"AUTO_PR_AI_GITHUB_MODEL",
							base.aiGitHubModel,
							"AUTO_PR_AI_GITHUB_MODEL required for github-models",
						);
						return {
							...shared,
							model: githubModel,
							ghToken,
							githubModel,
						};
					}),
				),
				Match.when("openai-compat", () =>
					Effect.gen(function* () {
						const openaiCompatUrl = yield* requireNonEmptyStringOption(
							"AUTO_PR_AI_OPENAI_COMPAT_URL",
							base.aiOpenaiCompatUrl,
							"AUTO_PR_AI_OPENAI_COMPAT_URL required for openai-compat",
						);
						const openaiCompatApiKey = yield* requireRedactedOption(
							"AUTO_PR_AI_OPENAI_COMPAT_API_KEY",
							base.aiOpenaiCompatApiKey,
							"AUTO_PR_AI_OPENAI_COMPAT_API_KEY required for openai-compat",
						);
						const openaiCompatModel = yield* requireNonEmptyStringOption(
							"AUTO_PR_AI_OPENAI_COMPAT_MODEL",
							base.aiOpenaiCompatModel,
							"AUTO_PR_AI_OPENAI_COMPAT_MODEL required for openai-compat",
						);
						return {
							...shared,
							model: openaiCompatModel,
							openaiCompatUrl,
							openaiCompatApiKey,
							openaiCompatModel,
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
	title: Config.string("TITLE"),
	bodyFile: Config.string("BODY_FILE"),
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
			const title = yield* requireNonEmpty("TITLE", base.title);
			const bodyFile = yield* requireNonEmpty("BODY_FILE", base.bodyFile);
			const workspace = yield* requireNonEmpty("GITHUB_WORKSPACE", base.workspace);
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
	readonly howToTestDefault: string;
	/** Set when `provider` is `github-models`. */
	readonly githubModel?: string;
	/** Set when `provider` is `openai-compat`. */
	readonly openaiCompatUrl?: string;
	readonly openaiCompatApiKey?: Redacted.Redacted<string>;
	readonly openaiCompatModel?: string;
}

export const RunAutoPrConfig = ServiceMap.Service<RunAutoPrConfig>("RunAutoPrConfig");

const RunAutoPrConfigDef = Config.all({
	defaultBranch: Config.string("DEFAULT_BRANCH"),
	workspace: Config.string("GITHUB_WORKSPACE"),
	templatePath: Config.string("PR_TEMPLATE_PATH"),
	ghToken: Config.redacted("GH_TOKEN"),
	aiProvider: Config.option(Config.string("AUTO_PR_AI_PROVIDER")),
	aiOllamaModel: Config.option(Config.string("AUTO_PR_AI_OLLAMA_MODEL")),
	aiGitHubModel: Config.option(Config.string("AUTO_PR_AI_GITHUB_MODEL")),
	aiOpenaiCompatUrl: Config.option(Config.string("AUTO_PR_AI_OPENAI_COMPAT_URL")),
	aiOpenaiCompatApiKey: Config.option(Config.redacted("AUTO_PR_AI_OPENAI_COMPAT_API_KEY")),
	aiOpenaiCompatModel: Config.option(Config.string("AUTO_PR_AI_OPENAI_COMPAT_MODEL")),
	branch: Config.option(Config.string("BRANCH")),
	howToTestDefault: Config.string("AUTO_PR_HOW_TO_TEST"),
});

export const RunAutoPrConfigLayer = Layer.effect(
	RunAutoPrConfig,
	mapConfigError(
		Effect.gen(function* () {
			const base = yield* RunAutoPrConfigDef;
			const defaultBranch = yield* requireNonEmpty("DEFAULT_BRANCH", base.defaultBranch);
			const workspace = yield* requireNonEmpty("GITHUB_WORKSPACE", base.workspace);
			const templatePath = yield* requireNonEmpty("PR_TEMPLATE_PATH", base.templatePath);
			const howToTestDefault = yield* requireNonEmpty("AUTO_PR_HOW_TO_TEST", base.howToTestDefault);

			const providerRaw = Option.getOrElse(base.aiProvider, () => "");
			yield* Option.match(base.aiProvider, {
				onNone: () => Effect.logWarning("AUTO_PR_AI_PROVIDER not set, defaulting to ollama"),
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
				howToTestDefault,
			};

			return yield* Match.value(provider).pipe(
				Match.when("ollama", () =>
					Effect.succeed({
						...shared,
						model: Option.getOrElse(base.aiOllamaModel, () => DEFAULT_OLLAMA_MODEL),
					}),
				),
				Match.when("github-models", () =>
					Effect.gen(function* () {
						const githubModel = yield* requireNonEmptyStringOption(
							"AUTO_PR_AI_GITHUB_MODEL",
							base.aiGitHubModel,
							"AUTO_PR_AI_GITHUB_MODEL required for github-models",
						);
						return {
							...shared,
							model: githubModel,
							githubModel,
						};
					}),
				),
				Match.when("openai-compat", () =>
					Effect.gen(function* () {
						const openaiCompatUrl = yield* requireNonEmptyStringOption(
							"AUTO_PR_AI_OPENAI_COMPAT_URL",
							base.aiOpenaiCompatUrl,
							"AUTO_PR_AI_OPENAI_COMPAT_URL required for openai-compat",
						);
						const openaiCompatApiKey = yield* requireRedactedOption(
							"AUTO_PR_AI_OPENAI_COMPAT_API_KEY",
							base.aiOpenaiCompatApiKey,
							"AUTO_PR_AI_OPENAI_COMPAT_API_KEY required for openai-compat",
						);
						const openaiCompatModel = yield* requireNonEmptyStringOption(
							"AUTO_PR_AI_OPENAI_COMPAT_MODEL",
							base.aiOpenaiCompatModel,
							"AUTO_PR_AI_OPENAI_COMPAT_MODEL required for openai-compat",
						);
						return {
							...shared,
							model: openaiCompatModel,
							openaiCompatUrl,
							openaiCompatApiKey,
							openaiCompatModel,
						};
					}),
				),
				Match.exhaustive,
			);
		}),
	),
);

// ─── FillPrTemplateConfig (CLI tool) ─────────────────────────────────────────

export interface FillPrTemplateConfig {
	readonly howToTestDefault: string;
}

export const FillPrTemplateConfig =
	ServiceMap.Service<FillPrTemplateConfig>("FillPrTemplateConfig");

const FillPrTemplateConfigDef = Config.all({
	howToTestDefault: Config.string("AUTO_PR_HOW_TO_TEST"),
});

export const FillPrTemplateConfigLayer = Layer.effect(
	FillPrTemplateConfig,
	mapConfigError(
		Effect.gen(function* () {
			const base = yield* FillPrTemplateConfigDef;
			const howToTestDefault = yield* requireNonEmpty("AUTO_PR_HOW_TO_TEST", base.howToTestDefault);
			return { howToTestDefault };
		}),
	),
);
