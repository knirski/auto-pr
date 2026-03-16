/**
 * Config services for auto-PR. Validate and fail early: required env vars are
 * required at load time; missing or empty vars cause immediate failure.
 * No default values for inputs.
 *
 * Each workflow has its own config with only the fields it needs. No Option for
 * required vars.
 */

import type { Redacted } from "effect";
import { Config, Effect, Layer, Option, ServiceMap } from "effect";
import { AutoPrConfigError } from "#auto-pr/errors.js";

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

export interface GeneratePrContentConfig {
	readonly commits: string;
	readonly files: string;
	readonly ghOutput: string;
	readonly workspace: string;
	readonly templatePath: string;
	readonly model: string;
	readonly ollamaUrl: string;
	readonly howToTestDefault: string;
}

export const GeneratePrContentConfig =
	ServiceMap.Service<GeneratePrContentConfig>("GeneratePrContentConfig");

const GeneratePrContentConfigDef = Config.all({
	commits: Config.string("COMMITS"),
	files: Config.string("FILES"),
	ghOutput: Config.string("GITHUB_OUTPUT"),
	workspace: Config.string("GITHUB_WORKSPACE"),
	templatePath: Config.string("PR_TEMPLATE_PATH"),
	model: Config.string("OLLAMA_MODEL"),
	ollamaUrl: Config.string("OLLAMA_URL"),
	howToTestDefault: Config.string("AUTO_PR_HOW_TO_TEST"),
});

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
			const model = yield* requireNonEmpty("OLLAMA_MODEL", base.model);
			const ollamaUrl = yield* requireNonEmpty("OLLAMA_URL", base.ollamaUrl);
			const howToTestDefault = yield* requireNonEmpty("AUTO_PR_HOW_TO_TEST", base.howToTestDefault);
			return {
				commits,
				files,
				ghOutput,
				workspace,
				templatePath,
				model,
				ollamaUrl,
				howToTestDefault,
			};
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
	readonly model: string;
	readonly ollamaUrl: string;
	readonly branch: string | undefined;
	readonly howToTestDefault: string;
}

export const RunAutoPrConfig = ServiceMap.Service<RunAutoPrConfig>("RunAutoPrConfig");

const RunAutoPrConfigDef = Config.all({
	defaultBranch: Config.string("DEFAULT_BRANCH"),
	workspace: Config.string("GITHUB_WORKSPACE"),
	templatePath: Config.string("PR_TEMPLATE_PATH"),
	ghToken: Config.redacted("GH_TOKEN"),
	model: Config.string("OLLAMA_MODEL"),
	ollamaUrl: Config.string("OLLAMA_URL"),
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
			const model = yield* requireNonEmpty("OLLAMA_MODEL", base.model);
			const ollamaUrl = yield* requireNonEmpty("OLLAMA_URL", base.ollamaUrl);
			const howToTestDefault = yield* requireNonEmpty("AUTO_PR_HOW_TO_TEST", base.howToTestDefault);
			return {
				defaultBranch,
				workspace,
				templatePath,
				ghToken: base.ghToken,
				model,
				ollamaUrl,
				branch: Option.getOrUndefined(base.branch),
				howToTestDefault,
			};
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
