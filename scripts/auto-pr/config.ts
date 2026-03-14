/**
 * Config services for auto-PR scripts. Schema-validated env vars.
 */

import { Effect, Layer, Schema, ServiceMap } from "effect";
import { AutoPrConfigError } from "./errors.js";

/** Default Ollama /api/generate URL. */
const DEFAULT_OLLAMA_URL = "http://localhost:11434/api/generate";

/** Default Ollama model for PR title/description generation. */
const DEFAULT_OLLAMA_MODEL = "llama3.1:8b";

// ─── Schemas ────────────────────────────────────────────────────────────────

const CreateOrUpdatePrConfigSchema = Schema.Struct({
	branch: Schema.String,
	defaultBranch: Schema.String,
	title: Schema.String,
	bodyFile: Schema.String,
	workspace: Schema.String,
});

const GeneratePrContentConfigSchema = Schema.Struct({
	commits: Schema.String,
	files: Schema.String,
	ghOutput: Schema.String,
	workspace: Schema.String,
	model: Schema.String,
	ollamaUrl: Schema.String,
});

const GetCommitsConfigSchema = Schema.Struct({
	defaultBranch: Schema.String,
	workspace: Schema.String,
	ghOutput: Schema.String,
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type CreateOrUpdatePrConfig = Schema.Schema.Type<typeof CreateOrUpdatePrConfigSchema>;
export type GeneratePrContentConfig = Schema.Schema.Type<typeof GeneratePrContentConfigSchema>;
export type GetCommitsConfig = Schema.Schema.Type<typeof GetCommitsConfigSchema>;

// ─── CreateOrUpdatePrConfig ─────────────────────────────────────────────────

interface CreateOrUpdatePrConfigService {
	readonly config: CreateOrUpdatePrConfig;
}

export const CreateOrUpdatePrConfig =
	ServiceMap.Service<CreateOrUpdatePrConfigService>("CreateOrUpdatePrConfig");

function buildCreateOrUpdatePrConfig(): Effect.Effect<CreateOrUpdatePrConfig, AutoPrConfigError> {
	const raw = {
		branch: process.env.BRANCH ?? "",
		defaultBranch: process.env.DEFAULT_BRANCH ?? "",
		title: process.env.TITLE ?? "",
		bodyFile: process.env.BODY_FILE ?? "",
		workspace: process.env.GITHUB_WORKSPACE ?? ".",
		ghToken: process.env.GH_TOKEN ?? "",
	};
	const required: Array<[string, string]> = [
		["BRANCH", raw.branch],
		["DEFAULT_BRANCH", raw.defaultBranch],
		["TITLE", raw.title],
		["BODY_FILE", raw.bodyFile],
		["GH_TOKEN", raw.ghToken],
	];
	const missing = required.filter(([, v]) => !v).map(([k]) => k);
	if (missing.length > 0) {
		return Effect.fail(new AutoPrConfigError({ missing }));
	}
	return Schema.decodeUnknownEffect(CreateOrUpdatePrConfigSchema)(raw).pipe(
		Effect.mapError(() => new AutoPrConfigError({ missing })),
	);
}

export const CreateOrUpdatePrConfigLayer = Layer.effect(
	CreateOrUpdatePrConfig,
	Effect.flatMap(buildCreateOrUpdatePrConfig(), (config) =>
		Effect.succeed({ config } satisfies CreateOrUpdatePrConfigService),
	),
);

// ─── GeneratePrContentConfig ─────────────────────────────────────────────────

interface GeneratePrContentConfigService {
	readonly config: GeneratePrContentConfig;
}

export const GeneratePrContentConfig =
	ServiceMap.Service<GeneratePrContentConfigService>("GeneratePrContentConfig");

function buildGeneratePrContentConfig(): Effect.Effect<GeneratePrContentConfig, AutoPrConfigError> {
	const commits = process.env.COMMITS?.trim() ?? "";
	const files = process.env.FILES?.trim() ?? "";
	const ghOutput = process.env.GITHUB_OUTPUT?.trim() ?? "";
	const workspace = process.env.GITHUB_WORKSPACE?.trim() ?? ".";
	const model = process.env.OLLAMA_MODEL?.trim() ?? DEFAULT_OLLAMA_MODEL;
	const ollamaUrl = process.env.OLLAMA_URL?.trim() ?? DEFAULT_OLLAMA_URL;

	const required: Array<[string, string]> = [
		["COMMITS", commits],
		["FILES", files],
		["GITHUB_OUTPUT", ghOutput],
	];
	const missing = required.filter(([, v]) => !v).map(([k]) => k);
	if (missing.length > 0) {
		return Effect.fail(new AutoPrConfigError({ missing }));
	}

	return Effect.succeed({
		commits,
		files,
		ghOutput,
		workspace,
		model,
		ollamaUrl,
	});
}

export const GeneratePrContentConfigLayer = Layer.effect(
	GeneratePrContentConfig,
	Effect.flatMap(buildGeneratePrContentConfig(), (config) =>
		Effect.succeed({ config } satisfies GeneratePrContentConfigService),
	),
);

// ─── GetCommitsConfig ───────────────────────────────────────────────────────

interface GetCommitsConfigService {
	readonly config: GetCommitsConfig;
}

export const GetCommitsConfig = ServiceMap.Service<GetCommitsConfigService>("GetCommitsConfig");

function buildGetCommitsConfig(): Effect.Effect<GetCommitsConfig, AutoPrConfigError> {
	const defaultBranch = process.env.DEFAULT_BRANCH?.trim() ?? "";
	const workspace = process.env.GITHUB_WORKSPACE?.trim() ?? "";
	const ghOutput = process.env.GITHUB_OUTPUT?.trim() ?? "";

	const required: Array<[string, string]> = [
		["DEFAULT_BRANCH", defaultBranch],
		["GITHUB_WORKSPACE", workspace],
		["GITHUB_OUTPUT", ghOutput],
	];
	const missing = required.filter(([, v]) => !v).map(([k]) => k);
	if (missing.length > 0) {
		return Effect.fail(new AutoPrConfigError({ missing }));
	}

	return Schema.decodeUnknownEffect(GetCommitsConfigSchema)({
		defaultBranch,
		workspace,
		ghOutput,
	}).pipe(Effect.mapError(() => new AutoPrConfigError({ missing })));
}

export const GetCommitsConfigLayer = Layer.effect(
	GetCommitsConfig,
	Effect.flatMap(buildGetCommitsConfig(), (config) =>
		Effect.succeed({ config } satisfies GetCommitsConfigService),
	),
);
