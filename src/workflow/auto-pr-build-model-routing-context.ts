import { Config, ConfigProvider, Effect, FileSystem, Layer, Match, Option } from "effect";
import { GitContext, GitContextLive } from "#auto-pr/git-context.js";
import { PlatformLayer as AutoPrPlatformLayer, ChildProcessSpawnerLayer } from "#auto-pr/shell.js";
import {
	RoutingContextEnvError,
	RoutingContextGitError,
	RoutingContextOutputError,
	RoutingContextParseError,
} from "#core/errors.js";
import { buildCommitSummary, buildFileSummary } from "#core/model-routing-context-core.js";
import {
	type BuildDetailedRoutingContextInput,
	buildDetailedRoutingContext,
	type LocalModelContext,
	type ModelBandDecision,
	type ModelBandSignals,
	type ModelProvider,
	parseCommitLog,
	resolveLocalRunnerResources,
	resolveModelBand,
} from "./model-routing.js";

type RoutingContextInputs = {
	readonly workspace: string;
	readonly defaultBranch: string;
	readonly provider: ModelProvider;
	readonly explicitModel: string | undefined;
	readonly openaiCompatUrl?: string;
	readonly llamacppModelUrl?: string;
	readonly runnerLabel?: string;
	readonly repositoryVisibility?: string;
	readonly localRunnerCpus?: number;
	readonly localRunnerMemoryGb?: number;
	readonly githubOutput: string;
	readonly commitsCount: number | undefined;
};

type RoutingContextSignalInput = Pick<
	BuildDetailedRoutingContextInput,
	"signals" | "commits" | "files"
>;

type RoutingContextError =
	| RoutingContextEnvError
	| RoutingContextParseError
	| RoutingContextGitError
	| RoutingContextOutputError;

const RoutingContextEnvConfig = Config.all({
	workspace: Config.option(Config.string("GITHUB_WORKSPACE")),
	defaultBranch: Config.option(Config.string("DEFAULT_BRANCH")),
	providerRaw: Config.option(Config.string("AUTO_PR_AI_PROVIDER")),
	githubOutput: Config.option(Config.string("GITHUB_OUTPUT")),
	explicitModel: Config.option(Config.string("AUTO_PR_AI_OPENAI_COMPAT_MODEL")),
	openaiCompatUrl: Config.option(Config.string("AUTO_PR_AI_OPENAI_COMPAT_URL")),
	llamacppModelUrl: Config.option(Config.string("AUTO_PR_AI_LLAMACPP_MODEL_URL")),
	runnerLabel: Config.option(Config.string("RUNNER_LABEL")),
	repositoryVisibility: Config.option(Config.string("REPOSITORY_VISIBILITY")),
	localRunnerCpusRaw: Config.option(Config.string("LOCAL_RUNNER_CPUS")),
	localRunnerMemoryGbRaw: Config.option(Config.string("LOCAL_RUNNER_MEMORY_GB")),
	commitsCountRaw: Config.option(Config.string("COMMITS_COUNT")),
});

function toCauseMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message.trim() || cause.name : String(cause);
}

function trimmedOrUndefined(option: Option.Option<string>): string | undefined {
	return Option.match(option, {
		onNone: () => undefined,
		onSome: (value) => {
			const trimmed = value.trim();
			return trimmed === "" ? undefined : trimmed;
		},
	});
}

function requireEnv(
	name: string,
	option: Option.Option<string>,
): Effect.Effect<string, RoutingContextEnvError> {
	return Option.match(option, {
		onNone: () => Effect.fail(new RoutingContextEnvError({ name })),
		onSome: (value) => {
			const trimmed = value.trim();
			return trimmed === ""
				? Effect.fail(new RoutingContextEnvError({ name }))
				: Effect.succeed(trimmed);
		},
	});
}

function parseProvider(raw: string): Effect.Effect<ModelProvider, RoutingContextParseError> {
	return Match.value(raw.trim()).pipe(
		Match.when("local", () => Effect.succeed("local" as const)),
		Match.when("github-models", () => Effect.succeed("github-models" as const)),
		Match.orElse(() =>
			Effect.fail(
				new RoutingContextParseError({
					name: "AUTO_PR_AI_PROVIDER",
					requirement: "local or github-models",
					value: raw,
				}),
			),
		),
	);
}

function parseOptionalPositiveInteger(
	raw: string | undefined,
	name: string,
): Effect.Effect<number | undefined, RoutingContextParseError> {
	if (raw === undefined) return Effect.succeed(undefined);
	const trimmed = raw.trim();
	if (trimmed === "") return Effect.succeed(undefined);
	const value = Number(trimmed);
	return Number.isInteger(value) && value >= 0
		? Effect.succeed(value)
		: Effect.fail(
				new RoutingContextParseError({
					name,
					requirement: "a non-negative integer",
					value: raw,
				}),
			);
}

function parseOptionalPositiveNumber(
	raw: string | undefined,
	name: string,
): Effect.Effect<number | undefined, RoutingContextParseError> {
	if (raw === undefined) return Effect.succeed(undefined);
	const trimmed = raw.trim();
	if (trimmed === "") return Effect.succeed(undefined);
	const value = Number(trimmed);
	return Number.isFinite(value) && value > 0
		? Effect.succeed(value)
		: Effect.fail(
				new RoutingContextParseError({
					name,
					requirement: "a positive number",
					value: raw,
				}),
			);
}

function parseEnvInputs(): Effect.Effect<
	RoutingContextInputs,
	RoutingContextEnvError | RoutingContextParseError
> {
	return Effect.gen(function* () {
		const raw = yield* RoutingContextEnvConfig.parse(ConfigProvider.fromEnv()).pipe(
			Effect.mapError(
				(error) =>
					new RoutingContextParseError({
						name: "ENV",
						requirement: "readable environment variables",
						value: error.message,
					}),
			),
		);
		const workspace = yield* requireEnv("GITHUB_WORKSPACE", raw.workspace);
		const defaultBranch = yield* requireEnv("DEFAULT_BRANCH", raw.defaultBranch);
		const providerRaw = yield* requireEnv("AUTO_PR_AI_PROVIDER", raw.providerRaw);
		const githubOutput = yield* requireEnv("GITHUB_OUTPUT", raw.githubOutput);
		const provider = yield* parseProvider(providerRaw);
		const explicitModel = trimmedOrUndefined(raw.explicitModel);
		const openaiCompatUrl = trimmedOrUndefined(raw.openaiCompatUrl);
		const llamacppModelUrl = trimmedOrUndefined(raw.llamacppModelUrl);
		const runnerLabel = trimmedOrUndefined(raw.runnerLabel);
		const repositoryVisibility = trimmedOrUndefined(raw.repositoryVisibility);
		const commitsCount = yield* parseOptionalPositiveInteger(
			trimmedOrUndefined(raw.commitsCountRaw),
			"COMMITS_COUNT",
		);
		const localRunnerCpus = yield* parseOptionalPositiveNumber(
			trimmedOrUndefined(raw.localRunnerCpusRaw),
			"LOCAL_RUNNER_CPUS",
		);
		const localRunnerMemoryGb = yield* parseOptionalPositiveNumber(
			trimmedOrUndefined(raw.localRunnerMemoryGbRaw),
			"LOCAL_RUNNER_MEMORY_GB",
		);
		return {
			workspace,
			defaultBranch,
			provider,
			explicitModel,
			...(openaiCompatUrl === undefined ? {} : { openaiCompatUrl }),
			...(llamacppModelUrl === undefined ? {} : { llamacppModelUrl }),
			...(runnerLabel === undefined ? {} : { runnerLabel }),
			...(repositoryVisibility === undefined ? {} : { repositoryVisibility }),
			...(localRunnerCpus === undefined ? {} : { localRunnerCpus }),
			...(localRunnerMemoryGb === undefined ? {} : { localRunnerMemoryGb }),
			githubOutput,
			commitsCount,
		};
	});
}

function mapGitError(command: string): (cause: unknown) => RoutingContextGitError {
	return (cause) => new RoutingContextGitError({ command, cause: toCauseMessage(cause) });
}

function buildRoutingContextInput(
	input: RoutingContextInputs,
): Effect.Effect<RoutingContextSignalInput, RoutingContextGitError, GitContext> {
	return Effect.gen(function* () {
		const git = yield* GitContext;
		const baseRef = `origin/${input.defaultBranch}`;
		const headRef = "HEAD";
		const filesOutput = yield* git
			.getChangedFiles(baseRef, headRef)
			.pipe(Effect.mapError(mapGitError(`diff --name-only ${baseRef}..${headRef}`)));
		const numstatOutput = yield* git
			.getDiffNumstat(baseRef, headRef)
			.pipe(Effect.mapError(mapGitError(`diff --numstat ${baseRef}..${headRef}`)));
		const nameStatusOutput = yield* git
			.getDiffNameStatus(baseRef, headRef)
			.pipe(Effect.mapError(mapGitError(`diff --name-status ${baseRef}..${headRef}`)));
		const logOutput = yield* git
			.getLog(baseRef, headRef)
			.pipe(Effect.mapError(mapGitError(`log --format=<default> ${baseRef}..${headRef}`)));

		const files = filesOutput
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		const numstat = numstatOutput
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		const nameStatus = nameStatusOutput
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		// GitContext log format prefixes each commit block with ---COMMIT---.
		// parseCommitLog handles separators when they are newline-prefixed.
		const commits = parseCommitLog(`\n${logOutput}`);
		const semanticCommits = commits.filter((commit) => !commit.subject.startsWith("Merge "));
		const mergeCommitCount = commits.length - semanticCommits.length;
		const commitSummary = buildCommitSummary(
			semanticCommits.map((commit) => ({
				type: commit.type,
				breaking: commit.breaking,
			})),
			mergeCommitCount,
		);
		const fileSummary = buildFileSummary({ files, numstat, nameStatus });
		const semanticCommitCount = input.commitsCount ?? semanticCommits.length;
		const signals: ModelBandSignals = {
			semanticCommitCount,
			conventionalTypeCount: new Set(
				semanticCommits.map((commit) => commit.type?.toLowerCase() ?? "").filter(Boolean),
			).size,
			topLevelSpread: fileSummary.topLevelDirs.length,
			changedFileCount: files.length,
			sourceFileCount: fileSummary.sourceFileCount,
			docsFileCount: fileSummary.docsFileCount,
			testFileCount: fileSummary.testFileCount,
			generatedFileCount: fileSummary.generatedFileCount,
			lockfileCount: fileSummary.lockfileCount,
			packageManifestCount: fileSummary.packageManifestCount,
			rawChurn: fileSummary.rawChurn,
			sourceChurn: fileSummary.sourceChurn,
			generatedChurn: fileSummary.generatedChurn,
			hasBreakingChange: semanticCommits.some((commit) => commit.breaking),
			hasBinaryFiles: fileSummary.hasBinaryFiles,
		};
		return {
			signals,
			commits: {
				...commitSummary,
				semanticCommitCount,
			},
			files: fileSummary,
		};
	});
}

function writeDecisionOutputs(
	githubOutput: string,
	decision: ModelBandDecision,
): Effect.Effect<void, RoutingContextOutputError, FileSystem.FileSystem> {
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const delimiter = `__AUTO_PR_ROUTING_CONTEXT_${globalThis.crypto.randomUUID()}__`;
		const lines = [
			`selected_model=${decision.selectedModel}`,
			`tool_strategy=${decision.toolStrategy}`,
			`reasoning_need=${decision.reasoningNeed}`,
			`requires_tool_calls=${decision.requiresToolCalls ? "true" : "false"}`,
			...(decision.localRunnerResources === undefined
				? []
				: [`local_runner_resources=${decision.localRunnerResources}`]),
			...(decision.localModelResourceFit === undefined
				? []
				: [`local_model_resource_fit=${decision.localModelResourceFit}`]),
			...(decision.localModelRecommendation === undefined
				? []
				: [`local_model_recommendation=${decision.localModelRecommendation}`]),
			`routing_context<<${delimiter}\n${decision.routingContext}\n${delimiter}`,
			`band=${decision.band}`,
		];
		yield* fs.writeFileString(githubOutput, `${lines.join("\n")}\n`, { flag: "a" }).pipe(
			Effect.mapError(
				(cause) =>
					new RoutingContextOutputError({
						path: githubOutput,
						cause: toCauseMessage(cause),
					}),
			),
		);
	});
}

export function runBuildModelRoutingContext(
	input: RoutingContextInputs,
): Effect.Effect<void, RoutingContextGitError | RoutingContextOutputError> {
	const gitLayer = GitContextLive(input.workspace).pipe(Layer.provide(ChildProcessSpawnerLayer));
	const runtimeLayer = Layer.mergeAll(AutoPrPlatformLayer, ChildProcessSpawnerLayer, gitLayer);
	return Effect.gen(function* () {
		const routingInput = yield* buildRoutingContextInput(input);
		const localModel: LocalModelContext | undefined = Match.value(input.provider).pipe(
			Match.when("local", () => ({
				...(input.openaiCompatUrl === undefined ? {} : { openaiCompatUrl: input.openaiCompatUrl }),
				...(input.llamacppModelUrl === undefined
					? {}
					: { llamacppModelUrl: input.llamacppModelUrl }),
				runner: resolveLocalRunnerResources({
					...(input.runnerLabel === undefined ? {} : { runnerLabel: input.runnerLabel }),
					...(input.repositoryVisibility === undefined
						? {}
						: { repositoryVisibility: input.repositoryVisibility }),
					...(input.localRunnerCpus === undefined ? {} : { cpuCount: input.localRunnerCpus }),
					...(input.localRunnerMemoryGb === undefined
						? {}
						: { memoryGb: input.localRunnerMemoryGb }),
				}),
			})),
			Match.when("github-models", () => undefined),
			Match.exhaustive,
		);
		const decision = resolveModelBand({
			provider: input.provider,
			signals: routingInput.signals,
			...(input.explicitModel === undefined ? {} : { explicitModel: input.explicitModel }),
			...(localModel === undefined ? {} : { localModel }),
		});
		const routingContext = buildDetailedRoutingContext({
			band: decision.band,
			selectedModel: decision.selectedModel,
			toolStrategy: decision.toolStrategy,
			reasoningNeed: decision.reasoningNeed,
			requiresToolCalls: decision.requiresToolCalls,
			signals: routingInput.signals,
			commits: routingInput.commits,
			files: routingInput.files,
			...(decision.localRunnerResources === undefined
				? {}
				: { localRunnerResources: decision.localRunnerResources }),
			...(decision.localModelResourceFit === undefined
				? {}
				: { localModelResourceFit: decision.localModelResourceFit }),
			...(decision.localModelRecommendation === undefined
				? {}
				: { localModelRecommendation: decision.localModelRecommendation }),
		});
		yield* writeDecisionOutputs(input.githubOutput, {
			...decision,
			routingContext,
		});
	}).pipe(Effect.provide(runtimeLayer));
}

export const program = Effect.gen(function* () {
	const input = yield* parseEnvInputs();
	yield* runBuildModelRoutingContext(input);
});

function formatProgramError(error: RoutingContextError): string {
	return Match.value(error).pipe(
		Match.tag("RoutingContextEnvError", ({ name }) => `${name} is required`),
		Match.tag(
			"RoutingContextParseError",
			({ name, requirement, value }) =>
				`${name} must be ${requirement}, got ${value.length === 0 ? "<empty>" : value}`,
		),
		Match.tag("RoutingContextGitError", ({ command, cause }) => `git ${command} failed: ${cause}`),
		Match.tag(
			"RoutingContextOutputError",
			({ path, cause }) => `Failed writing routing outputs to ${path}: ${cause}`,
		),
		Match.exhaustive,
	);
}

function isRoutingContextError(cause: unknown): cause is RoutingContextError {
	return (
		cause instanceof RoutingContextEnvError ||
		cause instanceof RoutingContextParseError ||
		cause instanceof RoutingContextGitError ||
		cause instanceof RoutingContextOutputError
	);
}

export function reportProgramError(error: unknown): void {
	const message = isRoutingContextError(error)
		? formatProgramError(error)
		: error instanceof Error
			? (error.stack ?? error.message)
			: String(error);
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
}

/* istanbul ignore next -- CLI main wrapper */
if (import.meta.main) {
	Effect.runPromise(program).catch(reportProgramError);
}
