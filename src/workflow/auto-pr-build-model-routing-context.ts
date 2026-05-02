import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { Effect } from "effect";
import {
	type BuildDetailedRoutingContextInput,
	buildDetailedRoutingContext,
	type LocalModelContext,
	type ModelBandDecision,
	type ModelBandSignals,
	type ModelProvider,
	parseCommitLog,
	type RoutingContextCommitSummary,
	type RoutingContextFileSummary,
	type RoutingContextHotspot,
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

type GitResult = {
	readonly stdout: string;
	readonly stderr: string;
};

type ParsedCommit = {
	readonly type: string | undefined;
	readonly breaking: boolean;
};

type RoutingContextSignalInput = Pick<
	BuildDetailedRoutingContextInput,
	"signals" | "commits" | "files"
>;

function toError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function readRequiredEnv(name: string): Effect.Effect<string, Error> {
	return Effect.try({
		try: () => {
			const value = process.env[name]?.trim();
			if (value === undefined || value === "") {
				throw new Error(`${name} is required`);
			}
			return value;
		},
		catch: toError,
	});
}

function parseProvider(raw: string): Effect.Effect<ModelProvider, Error> {
	return Effect.try({
		try: () => {
			if (raw === "local" || raw === "github-models") return raw;
			throw new Error(`AUTO_PR_AI_PROVIDER must be local or github-models, got ${raw}`);
		},
		catch: toError,
	});
}

function parseOptionalPositiveInteger(
	raw: string,
	name: string,
): Effect.Effect<number | undefined, Error> {
	return Effect.try({
		try: () => {
			const trimmed = raw.trim();
			if (trimmed === "") return undefined;
			const value = Number(trimmed);
			if (!Number.isInteger(value) || value < 0) {
				throw new Error(`${name} must be a non-negative integer, got ${raw}`);
			}
			return value;
		},
		catch: toError,
	});
}

function parseOptionalPositiveNumber(
	raw: string,
	name: string,
): Effect.Effect<number | undefined, Error> {
	return Effect.try({
		try: () => {
			const trimmed = raw.trim();
			if (trimmed === "") return undefined;
			const value = Number(trimmed);
			if (!Number.isFinite(value) || value <= 0) {
				throw new Error(`${name} must be a positive number, got ${raw}`);
			}
			return value;
		},
		catch: toError,
	});
}

function runGit(workspace: string, args: readonly string[]): Effect.Effect<GitResult, Error> {
	return Effect.try({
		try: () => {
			const result = spawnSync("git", [...args], { cwd: workspace, encoding: "utf8" });
			if (result.status !== 0) {
				throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
			}
			return { stdout: result.stdout, stderr: result.stderr };
		},
		catch: toError,
	});
}

function classifyFile(
	path: string,
): "source" | "docs" | "test" | "generated" | "lockfile" | "package" | "other" {
	if (
		/^(package-lock\.json|bun\.lock|bun\.lockb|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|flake\.lock)$/.test(
			path,
		)
	) {
		return "lockfile";
	}
	if (/^(package\.json|bun\.config\.[^/]+|flake\.nix)$/.test(path)) return "package";
	if (
		/(^|\/)(dist|build|out|coverage|vendor|__snapshots__|\.terraform)(\/|$)/.test(path) ||
		/(^|\/)\.next(\/|$)/.test(path) ||
		/\.lock$/.test(path) ||
		/\.min\.js$/.test(path) ||
		/\.map$/.test(path)
	) {
		return "generated";
	}
	if (/^docs\/|\.md$/.test(path)) return "docs";
	if (/^src\//.test(path)) return "source";
	if (/(^|\/)(test|tests|spec|specs)(\/|$)/.test(path) || /\.(test|spec)\.[^/]+$/.test(path))
		return "test";
	return "other";
}

function buildCommitSummary(
	commits: readonly ParsedCommit[],
	mergeCommitCount: number,
): RoutingContextCommitSummary {
	const typeCounts: Record<string, number> = Object.create(null);
	let breakingCommitCount = 0;
	for (const commit of commits) {
		if (commit.breaking) breakingCommitCount++;
		const type = commit.type?.trim().toLowerCase();
		if (type) {
			typeCounts[type] = (typeCounts[type] ?? 0) + 1;
		}
	}
	return {
		semanticCommitCount: commits.length,
		mergeCommitCount,
		breakingCommitCount,
		typeCounts,
	};
}

function sortHotspots(items: RoutingContextHotspot[]): RoutingContextHotspot[] {
	return items.sort((a, b) => {
		if (b.churn !== a.churn) return b.churn - a.churn;
		return a.path.localeCompare(b.path);
	});
}

function buildFileSummary(input: {
	readonly files: readonly string[];
	readonly numstat: readonly string[];
	readonly nameStatus: readonly string[];
}): RoutingContextFileSummary {
	const topLevelDirs = new Set<string>();
	const topDirChurn = new Map<string, RoutingContextHotspot>();
	const fileHotspots = new Map<string, RoutingContextHotspot>();

	let sourceFileCount = 0;
	let docsFileCount = 0;
	let testFileCount = 0;
	let generatedFileCount = 0;
	let lockfileCount = 0;
	let packageManifestCount = 0;
	let rawChurn = 0;
	let sourceChurn = 0;
	let generatedChurn = 0;
	let hasBinaryFiles = false;
	let addedFileCount = 0;
	let modifiedFileCount = 0;
	let deletedFileCount = 0;
	let renamedFileCount = 0;

	for (const file of input.files) {
		const top = file.split("/", 1)[0] ?? "";
		topLevelDirs.add(top);
		switch (classifyFile(file)) {
			case "source":
				sourceFileCount++;
				break;
			case "docs":
				docsFileCount++;
				break;
			case "test":
				testFileCount++;
				break;
			case "generated":
				generatedFileCount++;
				break;
			case "lockfile":
				lockfileCount++;
				break;
			case "package":
				packageManifestCount++;
				break;
		}
	}

	for (const line of input.nameStatus) {
		const [statusRaw] = line.split(/\s+/);
		const status = statusRaw?.charAt(0) ?? "";
		if (status === "A") addedFileCount++;
		if (status === "M") modifiedFileCount++;
		if (status === "D") deletedFileCount++;
		if (status === "R") renamedFileCount++;
	}

	for (const line of input.numstat) {
		const [insRaw, delRaw, ...rest] = line.split(/\s+/);
		const path = rest.join(" ");
		if (!path) continue;
		const insertions = insRaw === "-" ? 0 : Number(insRaw);
		const deletions = delRaw === "-" ? 0 : Number(delRaw);
		if (insRaw === "-" || delRaw === "-") hasBinaryFiles = true;
		const churn = insertions + deletions;
		rawChurn += churn;
		const kind = classifyFile(path);
		if (kind === "generated") generatedChurn += churn;
		if (kind === "source") sourceChurn += churn;

		const fileEntry: RoutingContextHotspot = {
			path,
			churn,
			insertions,
			deletions,
			kind,
		};
		fileHotspots.set(path, fileEntry);

		const top = path.split("/", 1)[0] ?? path;
		const dirEntry = topDirChurn.get(top);
		if (dirEntry === undefined) {
			topDirChurn.set(top, { ...fileEntry, path: top });
		} else {
			dirEntry.churn += churn;
			dirEntry.insertions += insertions;
			dirEntry.deletions += deletions;
		}
	}

	return {
		changedFiles: [...input.files],
		topLevelDirs: [...topLevelDirs].sort((a, b) => a.localeCompare(b)),
		topFiles: sortHotspots([...fileHotspots.values()]),
		topDirs: sortHotspots([...topDirChurn.values()]),
		sourceFileCount,
		docsFileCount,
		testFileCount,
		generatedFileCount,
		lockfileCount,
		packageManifestCount,
		rawChurn,
		sourceChurn,
		generatedChurn,
		hasBinaryFiles,
		addedFileCount,
		modifiedFileCount,
		deletedFileCount,
		renamedFileCount,
	};
}

function buildRoutingContextInput(
	input: RoutingContextInputs,
): Effect.Effect<RoutingContextSignalInput, Error> {
	return Effect.gen(function* () {
		const range = `origin/${input.defaultBranch}..HEAD`;
		const filesOutput = yield* runGit(input.workspace, ["diff", "--name-only", range]);
		const numstatOutput = yield* runGit(input.workspace, ["diff", "--numstat", range]);
		const nameStatusOutput = yield* runGit(input.workspace, ["diff", "--name-status", range]);
		const logOutput = yield* runGit(input.workspace, [
			"log",
			"--format=%H%n%B%n---COMMIT---",
			range,
		]);

		const files = filesOutput.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		const numstat = numstatOutput.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		const nameStatus = nameStatusOutput.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		const commits = parseCommitLog(logOutput.stdout);
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
): Effect.Effect<void, Error> {
	return Effect.try({
		try: () => {
			appendFileSync(githubOutput, `selected_model=${decision.selectedModel}\n`);
			appendFileSync(githubOutput, `tool_strategy=${decision.toolStrategy}\n`);
			appendFileSync(githubOutput, `reasoning_need=${decision.reasoningNeed}\n`);
			appendFileSync(
				githubOutput,
				`requires_tool_calls=${decision.requiresToolCalls ? "true" : "false"}\n`,
			);
			if (decision.localRunnerResources !== undefined) {
				appendFileSync(githubOutput, `local_runner_resources=${decision.localRunnerResources}\n`);
			}
			if (decision.localModelResourceFit !== undefined) {
				appendFileSync(
					githubOutput,
					`local_model_resource_fit=${decision.localModelResourceFit}\n`,
				);
			}
			if (decision.localModelRecommendation !== undefined) {
				appendFileSync(
					githubOutput,
					`local_model_recommendation=${decision.localModelRecommendation}\n`,
				);
			}
			const delimiter = `__AUTO_PR_ROUTING_CONTEXT_${randomUUID()}__`;
			appendFileSync(
				githubOutput,
				`routing_context<<${delimiter}\n${decision.routingContext}\n${delimiter}\n`,
			);
			appendFileSync(githubOutput, `band=${decision.band}\n`);
		},
		catch: toError,
	});
}

export function runBuildModelRoutingContext(
	input: RoutingContextInputs,
): Effect.Effect<void, Error> {
	return Effect.gen(function* () {
		const routingInput = yield* buildRoutingContextInput(input);
		const localModel: LocalModelContext | undefined =
			input.provider === "local"
				? {
						...(input.openaiCompatUrl === undefined
							? {}
							: { openaiCompatUrl: input.openaiCompatUrl }),
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
					}
				: undefined;
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
	});
}

export const program = Effect.gen(function* () {
	const workspace = yield* readRequiredEnv("GITHUB_WORKSPACE");
	const defaultBranch = yield* readRequiredEnv("DEFAULT_BRANCH");
	const providerRaw = yield* readRequiredEnv("AUTO_PR_AI_PROVIDER");
	const githubOutput = yield* readRequiredEnv("GITHUB_OUTPUT");
	const explicitModelRaw = yield* Effect.sync(
		() => process.env.AUTO_PR_AI_OPENAI_COMPAT_MODEL?.trim() ?? "",
	);
	const openaiCompatUrlRaw = yield* Effect.sync(
		() => process.env.AUTO_PR_AI_OPENAI_COMPAT_URL?.trim() ?? "",
	);
	const llamacppModelUrlRaw = yield* Effect.sync(
		() => process.env.AUTO_PR_AI_LLAMACPP_MODEL_URL?.trim() ?? "",
	);
	const runnerLabelRaw = yield* Effect.sync(() => process.env.RUNNER_LABEL?.trim() ?? "");
	const repositoryVisibilityRaw = yield* Effect.sync(
		() => process.env.REPOSITORY_VISIBILITY?.trim() ?? "",
	);
	const localRunnerCpusRaw = yield* Effect.sync(() => process.env.LOCAL_RUNNER_CPUS?.trim() ?? "");
	const localRunnerMemoryGbRaw = yield* Effect.sync(
		() => process.env.LOCAL_RUNNER_MEMORY_GB?.trim() ?? "",
	);
	const commitsCountRaw = yield* Effect.sync(() => process.env.COMMITS_COUNT?.trim() ?? "");
	const provider = yield* parseProvider(providerRaw);
	const commitsCount = yield* parseOptionalPositiveInteger(commitsCountRaw, "COMMITS_COUNT");
	const localRunnerCpus = yield* parseOptionalPositiveNumber(
		localRunnerCpusRaw,
		"LOCAL_RUNNER_CPUS",
	);
	const localRunnerMemoryGb = yield* parseOptionalPositiveNumber(
		localRunnerMemoryGbRaw,
		"LOCAL_RUNNER_MEMORY_GB",
	);
	yield* runBuildModelRoutingContext({
		workspace,
		defaultBranch,
		provider,
		explicitModel: explicitModelRaw === "" ? undefined : explicitModelRaw,
		...(openaiCompatUrlRaw === "" ? {} : { openaiCompatUrl: openaiCompatUrlRaw }),
		...(llamacppModelUrlRaw === "" ? {} : { llamacppModelUrl: llamacppModelUrlRaw }),
		...(runnerLabelRaw === "" ? {} : { runnerLabel: runnerLabelRaw }),
		...(repositoryVisibilityRaw === "" ? {} : { repositoryVisibility: repositoryVisibilityRaw }),
		...(localRunnerCpus === undefined ? {} : { localRunnerCpus }),
		...(localRunnerMemoryGb === undefined ? {} : { localRunnerMemoryGb }),
		githubOutput,
		commitsCount,
	});
});

export function reportProgramError(error: unknown): void {
	process.stderr.write(
		`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
	);
	process.exitCode = 1;
}

/* istanbul ignore next -- CLI main wrapper */
if (import.meta.main) {
	Effect.runPromise(program).catch(reportProgramError);
}
