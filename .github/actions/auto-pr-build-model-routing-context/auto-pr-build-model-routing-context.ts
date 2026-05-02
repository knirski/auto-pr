import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { Effect, Option, Result } from "effect";
import { parseCommits } from "../../../src/core/fill-pr-template-core.js";
import {
	type ModelBandDecision,
	type ModelBandSignals,
	type ModelProvider,
	resolveModelBand,
} from "../../../src/core/model-band.js";

type RoutingContextInputs = {
	readonly workspace: string;
	readonly defaultBranch: string;
	readonly provider: ModelProvider;
	readonly explicitModel: string | undefined;
	readonly githubOutput: string;
	readonly commitsCount: number | undefined;
};

type GitResult = {
	readonly stdout: string;
	readonly stderr: string;
};

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
			throw new Error(`AI_PROVIDER must be local or github-models, got ${raw}`);
		},
		catch: toError,
	});
}

function parseOptionalPositiveInteger(raw: string): Effect.Effect<number | undefined, Error> {
	return Effect.try({
		try: () => {
			const trimmed = raw.trim();
			if (trimmed === "") return undefined;
			const value = Number(trimmed);
			if (!Number.isInteger(value) || value < 0) {
				throw new Error(`COMMITS_COUNT must be a non-negative integer, got ${raw}`);
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
		/(^|\/)(dist|build|out|coverage|vendor|__snapshots__|\.terraform)(\/|$)/.test(path) ||
		/(^|\/)\.next(\/|$)/.test(path) ||
		/(^|\/)(pnpm-lock\.yaml|package-lock\.json|Cargo\.lock|go\.sum)$/.test(path) ||
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
	if (
		/^(package(?:-lock)?\.json|bun\.lock|bun\.lockb|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum)$/.test(
			path,
		)
	)
		return "lockfile";
	if (/^(package\.json|bun\.config\.[^/]+)$/.test(path)) return "package";
	return "other";
}

function buildSignals(input: RoutingContextInputs): Effect.Effect<ModelBandSignals, Error> {
	return Effect.gen(function* () {
		const range = `origin/${input.defaultBranch}..HEAD`;
		const filesOutput = yield* runGit(input.workspace, ["diff", "--name-only", range]);
		const numstatOutput = yield* runGit(input.workspace, ["diff", "--numstat", range]);
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
		const parsed = parseCommits(logOutput.stdout);
		if (Result.isFailure(parsed)) {
			return yield* Effect.fail(new Error(parsed.failure.message));
		}

		const commits = parsed.success;
		const semanticCommits = commits.filter((commit) => !commit.subject.startsWith("Merge "));
		const conventionalTypeCount = new Set(
			semanticCommits
				.map((commit) => Option.getOrElse(commit.type, () => "").toLowerCase())
				.filter(Boolean),
		).size;

		let sourceFileCount = 0;
		let docsFileCount = 0;
		let testFileCount = 0;
		let generatedFileCount = 0;
		let lockfileCount = 0;
		let packageManifestCount = 0;
		const topLevel = new Set<string>();
		for (const file of files) {
			const top = file.split("/", 1)[0] ?? "";
			topLevel.add(top);
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

		let rawChurn = 0;
		let sourceChurn = 0;
		let generatedChurn = 0;
		let hasBinaryFiles = false;
		for (const line of numstat) {
			const [insRaw, delRaw, ...rest] = line.split(/\s+/);
			const path = rest.join(" ");
			if (!path) continue;
			const insertions = insRaw === "-" ? 0 : Number(insRaw);
			const deletions = delRaw === "-" ? 0 : Number(delRaw);
			if (insRaw === "-" || delRaw === "-") hasBinaryFiles = true;
			const churn = insertions + deletions;
			rawChurn += churn;
			if (classifyFile(path) === "generated") generatedChurn += churn;
			else sourceChurn += churn;
		}

		const hasBreakingChange = semanticCommits.some((commit) => Option.isSome(commit.breakingNote));
		const semanticCommitCount = input.commitsCount ?? semanticCommits.length;
		return {
			semanticCommitCount,
			conventionalTypeCount,
			topLevelSpread: topLevel.size,
			changedFileCount: files.length,
			sourceFileCount,
			docsFileCount,
			testFileCount,
			generatedFileCount,
			lockfileCount,
			packageManifestCount,
			rawChurn,
			sourceChurn,
			generatedChurn,
			hasBreakingChange,
			hasBinaryFiles,
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
			appendFileSync(githubOutput, `routing_context=${decision.routingContext}\n`);
			appendFileSync(githubOutput, `band=${decision.band}\n`);
		},
		catch: toError,
	});
}

export function runBuildModelRoutingContext(
	input: RoutingContextInputs,
): Effect.Effect<void, Error> {
	return Effect.gen(function* () {
		const signals = yield* buildSignals(input);
		const decision = resolveModelBand({
			provider: input.provider,
			signals,
			...(input.explicitModel === undefined ? {} : { explicitModel: input.explicitModel }),
		});
		yield* writeDecisionOutputs(input.githubOutput, decision);
	});
}

export const program = Effect.gen(function* () {
	const workspace = yield* readRequiredEnv("WORKSPACE");
	const defaultBranch = yield* readRequiredEnv("DEFAULT_BRANCH");
	const providerRaw = yield* readRequiredEnv("AI_PROVIDER");
	const githubOutput = yield* readRequiredEnv("GITHUB_OUTPUT");
	const explicitModelRaw = yield* Effect.sync(() => process.env.INPUT_MODEL?.trim() ?? "");
	const commitsCountRaw = yield* Effect.sync(() => process.env.COMMITS_COUNT?.trim() ?? "");
	const provider = yield* parseProvider(providerRaw);
	const commitsCount = yield* parseOptionalPositiveInteger(commitsCountRaw);
	yield* runBuildModelRoutingContext({
		workspace,
		defaultBranch,
		provider,
		explicitModel: explicitModelRaw === "" ? undefined : explicitModelRaw,
		githubOutput,
		commitsCount,
	});
});

if (import.meta.main) {
	Effect.runPromise(program).catch((error) => {
		process.stderr.write(
			`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
		);
		process.exitCode = 1;
	});
}
