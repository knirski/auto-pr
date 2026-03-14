/**
 * Get commit log and changed files for auto-PR workflow.
 * Writes commits.txt, subjects.txt, files.txt, semantic_subjects.txt.
 * Outputs to GITHUB_OUTPUT: commits, files, count (semantic commit count).
 *
 * Requires env: DEFAULT_BRANCH (e.g. main), GITHUB_WORKSPACE, GITHUB_OUTPUT
 *
 * Run: npx tsx scripts/auto-pr-get-commits.ts
 */

import { Effect, FileSystem, Path } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import {
	AutoPrPlatformLayer,
	appendGhOutput,
	ChildProcessSpawnerLayer,
	filterSemanticSubjects,
	GetCommitsConfig,
	GetCommitsConfigLayer,
	NoSemanticCommits,
	runCommand,
	runMain,
} from "./auto-pr/index.js";

// ─── Constants ────────────────────────────────────────────────────────────

const BASE_REF_PREFIX = "origin/";

// ─── Shell (Effect) ──────────────────────────────────────────────────────────

function runGetCommits(
	defaultBranch: string,
	workspace: string,
): Effect.Effect<
	{ commits: string; subjects: string; files: string; semanticSubjects: string[] },
	Error,
	ChildProcessSpawner
> {
	const baseRef = `${BASE_REF_PREFIX}${defaultBranch}`;
	return Effect.gen(function* () {
		const [commits, subjects, files] = yield* Effect.all([
			runCommand("git", ["log", "--format=---COMMIT---%n%s%n%n%b", `${baseRef}..HEAD`], workspace),
			runCommand("git", ["log", "--format=%s", `${baseRef}..HEAD`], workspace),
			runCommand("git", ["diff", "--name-only", `${baseRef}..HEAD`], workspace),
		]);
		const subjectLines = subjects.split("\n").filter(Boolean);
		const semanticSubjects = filterSemanticSubjects(subjectLines);
		return {
			commits,
			subjects,
			files,
			semanticSubjects,
		};
	});
}

function writeOutputFiles(
	workspace: string,
	data: {
		commits: string;
		subjects: string;
		files: string;
		semanticSubjects: string[];
	},
): Effect.Effect<void, Error, FileSystem.FileSystem | Path.Path> {
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const pathApi = yield* Path.Path;
		const commitsPath = pathApi.join(workspace, "commits.txt");
		const subjectsPath = pathApi.join(workspace, "subjects.txt");
		const filesPath = pathApi.join(workspace, "files.txt");
		const semanticPath = pathApi.join(workspace, "semantic_subjects.txt");
		yield* Effect.all([
			fs.writeFileString(commitsPath, data.commits),
			fs.writeFileString(subjectsPath, data.subjects),
			fs.writeFileString(filesPath, data.files),
			fs.writeFileString(semanticPath, `${data.semanticSubjects.join("\n")}\n`),
		]);
	});
}

/** Main pipeline. Exported for tests. */
export function runAutoPrGetCommits(
	defaultBranch: string,
	workspace: string,
	ghOutput: string,
): Effect.Effect<void, Error, ChildProcessSpawner | FileSystem.FileSystem | Path.Path> {
	return Effect.gen(function* () {
		const data = yield* runGetCommits(defaultBranch, workspace);

		if (data.semanticSubjects.length === 0) {
			return yield* Effect.fail(
				new NoSemanticCommits({
					message:
						"No semantic commits (all merge or non-semantic). Add at least one non-merge commit before pushing to ai/ branch.",
				}),
			);
		}

		yield* writeOutputFiles(workspace, data);
		const pathApi = yield* Path.Path;
		const commitsPath = pathApi.join(workspace, "commits.txt");
		const filesPath = pathApi.join(workspace, "files.txt");
		const entries = [
			{ key: "commits", value: commitsPath },
			{ key: "files", value: filesPath },
			{ key: "count", value: String(data.semanticSubjects.length) },
		];
		yield* appendGhOutput(ghOutput, entries);
	});
}

// ─── Entry ──────────────────────────────────────────────────────────────────

const program = Effect.gen(function* () {
	const config = yield* GetCommitsConfig;
	const { defaultBranch, workspace, ghOutput } = config.config;
	yield* runAutoPrGetCommits(defaultBranch, workspace, ghOutput);
}).pipe(
	Effect.provide(GetCommitsConfigLayer),
	Effect.provide(AutoPrPlatformLayer),
	Effect.provide(ChildProcessSpawnerLayer),
);

if (import.meta.main) {
	runMain(program, "auto_pr_get_commits_failed");
}
