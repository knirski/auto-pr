#!/usr/bin/env node

import { B as NoSemanticCommitsError, F as GetCommitsConfig, I as GetCommitsConfigLayer, a as runCommand, b as buildGetCommitsGhEntries, i as appendGhOutput, n as ChildProcessSpawnerLayer, o as runMain, r as PlatformLayer, w as parseSubjects, x as filterSemanticSubjects } from "../auto-pr-gJsKsYcH.mjs";
import { Effect, FileSystem, Path } from "effect";
//#region src/workflow/auto-pr-get-commits.ts
/**
* Get commit log and changed files for auto-PR workflow.
* Writes commits.txt, subjects.txt, files.txt, semantic_subjects.txt.
* Outputs to GITHUB_OUTPUT: commits, files, count (semantic commit count).
*
* Requires env: DEFAULT_BRANCH (e.g. main), GITHUB_WORKSPACE, GITHUB_OUTPUT
*
* Run: npx tsx src/workflow/auto-pr-get-commits.ts (or: node dist/workflow/auto-pr-get-commits.mjs)
*/
const BASE_REF_PREFIX = "origin/";
function runGetCommits(defaultBranch, workspace) {
	const baseRef = `${BASE_REF_PREFIX}${defaultBranch}`;
	return Effect.gen(function* () {
		const [commits, subjects, files] = yield* Effect.all([
			runCommand("git", [
				"log",
				"--format=---COMMIT---%n%s%n%n%b",
				`${baseRef}..HEAD`
			], workspace),
			runCommand("git", [
				"log",
				"--format=%s",
				`${baseRef}..HEAD`
			], workspace),
			runCommand("git", [
				"diff",
				"--name-only",
				`${baseRef}..HEAD`
			], workspace)
		]);
		return {
			commits,
			subjects,
			files,
			semanticSubjects: filterSemanticSubjects(parseSubjects(subjects))
		};
	});
}
function writeOutputFiles(workspace, data) {
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
			fs.writeFileString(semanticPath, `${data.semanticSubjects.join("\n")}\n`)
		]);
	});
}
/** Main pipeline. Exported for tests. */
function runAutoPrGetCommits(defaultBranch, workspace, ghOutput) {
	return Effect.gen(function* () {
		const data = yield* runGetCommits(defaultBranch, workspace);
		if (data.semanticSubjects.length === 0) return yield* Effect.fail(new NoSemanticCommitsError({ message: "No semantic commits (all merge or non-semantic). Add at least one non-merge commit before pushing to ai/ branch." }));
		yield* writeOutputFiles(workspace, data);
		const pathApi = yield* Path.Path;
		yield* appendGhOutput(ghOutput, buildGetCommitsGhEntries(pathApi.join(workspace, "commits.txt"), pathApi.join(workspace, "files.txt"), data.semanticSubjects.length));
		yield* Effect.log({
			event: "auto_pr_get_commits",
			status: "success",
			count: data.semanticSubjects.length
		});
	});
}
const program = Effect.gen(function* () {
	const { defaultBranch, workspace, ghOutput } = yield* GetCommitsConfig;
	yield* runAutoPrGetCommits(defaultBranch, workspace, ghOutput);
}).pipe(Effect.provide(GetCommitsConfigLayer), Effect.provide(PlatformLayer), Effect.provide(ChildProcessSpawnerLayer));
if (import.meta.main) runMain(program, "auto_pr_get_commits_failed");
//#endregion
export { runAutoPrGetCommits };

//# sourceMappingURL=auto-pr-get-commits.mjs.map