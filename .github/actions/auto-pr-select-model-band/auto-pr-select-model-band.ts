import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { Option, Result } from "effect";
import { parseCommits } from "../../../src/core/fill-pr-template-core.js";
import { type ModelBandSignals, resolveModelBand } from "../../../src/core/model-band.js";

const workspace = process.env.WORKSPACE?.trim() ?? "";
const defaultBranch = process.env.DEFAULT_BRANCH?.trim() ?? "";
const provider = process.env.AI_PROVIDER?.trim();
const explicitModel = process.env.INPUT_MODEL?.trim() ?? "";
const githubOutput = process.env.GITHUB_OUTPUT?.trim() ?? "";
const commitsCountEnv = process.env.COMMITS_COUNT?.trim() ?? "";

if (workspace === "" || defaultBranch === "" || provider === undefined || githubOutput === "") {
	throw new Error("WORKSPACE, DEFAULT_BRANCH, AI_PROVIDER, and GITHUB_OUTPUT are required");
}

type GitResult = { readonly stdout: string; readonly stderr: string };

function runGit(args: readonly string[]): GitResult {
	const r = spawnSync("git", [...args], { cwd: workspace, encoding: "utf8" });
	if (r.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
	}
	return { stdout: r.stdout, stderr: r.stderr };
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

function buildSignals(): ModelBandSignals {
	const range = `origin/${defaultBranch}..HEAD`;
	const files = runGit(["diff", "--name-only", range])
		.stdout.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	const numstat = runGit(["diff", "--numstat", range])
		.stdout.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	const logOutput = runGit(["log", "--format=%H%n%B%n---COMMIT---", range]).stdout;
	const parsed = parseCommits(logOutput);
	if (Result.isFailure(parsed)) {
		throw new Error(parsed.failure.message);
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
		const top = file.split("/", 1)[0];
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
	const signals: ModelBandSignals = {
		semanticCommitCount: commitsCountEnv === "" ? semanticCommits.length : Number(commitsCountEnv),
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
	return signals;
}

const decision = resolveModelBand({
	provider: provider === "github-models" || provider === "local" ? provider : "local",
	explicitModel: explicitModel === "" ? undefined : explicitModel,
	signals: buildSignals(),
});

appendFileSync(githubOutput, `selected_model=${decision.selectedModel}\n`);
appendFileSync(githubOutput, `routing_context=${decision.routingContext}\n`);
appendFileSync(githubOutput, `band=${decision.band}\n`);
