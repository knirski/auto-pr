import { describe, expect, test } from "bun:test";
import { CommitParser } from "conventional-commits-parser";
import { Option, pipe, Result } from "effect";
import type { CommitInfo } from "#core/fill-pr-template-core.js";
import {
	extractBreakingDescriptionFromLine,
	fillTemplate,
	filterMergeCommits,
	fitConventionalTitleToLengthLimit,
	formatTitleBody,
	getBreakingChanges,
	getChanges,
	getDescription,
	getDescriptionFromCommits,
	getDescriptionPromptText,
	getRelatedIssues,
	hasDocsFiles,
	hasTestFiles,
	hasUnreplacedPlaceholders,
	inferTypeOfChange,
	isConventional,
	isDocsOnly,
	isMergeCommit,
	isValidConventionalTitle,
	isWithinLengthLimit,
	matchesConventionalTitleFormat,
	parseCommits,
	parseFilesContent,
	renderBody,
	resolveBreakingChangesBody,
	validateTitleDescription,
} from "#core/fill-pr-template-core.js";
import { PR_TITLE_LINE_MAX_LENGTH } from "#core/pr-title-line-max-length.js";

/** Subject repeat count so `feat: ${"x".repeat(...)}` is one character over {@link PR_TITLE_LINE_MAX_LENGTH}. */
const FEAT_COLON_SUBJECT_OVER_MAX = PR_TITLE_LINE_MAX_LENGTH - "feat: ".length + 1;

const TEST_TEMPLATE = `## Description
{{description}}

## Type of change
**{{typeOfChange}}**. See [Conventional Commits](https://www.conventionalcommits.org/).

## Changes made
{{changes}}

## How to test

1. Run the relevant tests or checks.
2. 

## Checklist
- [{{checklistConventional}}] My commits follow [Conventional Commits](https://www.conventionalcommits.org/)
- [ ] I have run \`npm run check\` and fixed any issues
- [{{checklistDocs}}] I have updated the documentation if needed
- [{{checklistTests}}] I have added or updated tests for my changes

## Related issues
{{relatedIssues}}

## Breaking changes
{{breakingChanges}}
`;

const commit = (
	subject: string,
	body: string,
	opts?: { type?: string; references?: string[]; breakingNote?: string | null },
): CommitInfo => ({
	subject,
	body,
	fullMessage: `${subject}\n\n${body}`.trim(),
	type: opts?.type ?? null,
	references: opts?.references ?? [],
	breakingNote: opts?.breakingNote ?? null,
});

describe("fill-pr-template-core", () => {
	describe("parseCommits", () => {
		test("parses single commit", () => {
			pipe(
				parseCommits("---COMMIT---\nfeat: add foo\nbody line 1"),
				Result.match({
					onSuccess: (commits) => {
						expect(commits).toHaveLength(1);
						expect(commits[0]?.subject).toBe("feat: add foo");
						expect(commits[0]?.body).toBe("body line 1");
						expect(commits[0]?.type).toBe("feat");
					},
					onFailure: () => expect().fail("expected success"),
				}),
			);
		});

		test("parses multiple commits", () => {
			pipe(
				parseCommits("---COMMIT---\nfeat: first\n\n---COMMIT---\nfix: second\nbody"),
				Result.match({
					onSuccess: (commits) => {
						expect(commits).toHaveLength(2);
						expect(commits[0]?.subject).toBe("feat: first");
						expect(commits[1]?.subject).toBe("fix: second");
						expect(commits[1]?.body).toBe("body");
					},
					onFailure: () => expect().fail("expected success"),
				}),
			);
		});

		test("ignores non-numeric #refs in prose (e.g. TS path alias #core)", () => {
			const block = `---COMMIT---
chore: require token; drop core re-export

Delete src/auto-pr/core.ts; export gh helpers from #core in index.
Made-with: Cursor`;
			pipe(
				parseCommits(block),
				Result.match({
					onSuccess: (commits) => {
						expect(commits).toHaveLength(1);
						expect(commits[0]?.references).toEqual([]);
					},
					onFailure: () => expect().fail("expected success"),
				}),
			);
		});

		test("returns empty for empty input", () => {
			pipe(
				parseCommits(""),
				Result.match({
					onSuccess: (commits) => expect(commits).toEqual([]),
					onFailure: () => expect().fail("expected success"),
				}),
			);
		});

		test("returns ParseError when underlying parser throws", () => {
			const original = CommitParser.prototype.parse;
			CommitParser.prototype.parse = function parseThrows() {
				throw new Error("forced parser failure");
			};
			try {
				pipe(
					parseCommits("---COMMIT---\nfeat: x"),
					Result.match({
						onSuccess: () => expect().fail("expected failure"),
						onFailure: (e) => {
							expect(e._tag).toBe("ParseError");
							expect(e.message).toBe("Failed to parse commits");
						},
					}),
				);
			} finally {
				CommitParser.prototype.parse = original;
			}
		});
	});

	describe("parseFilesContent", () => {
		test("splits and trims newline-separated paths", () => {
			expect(parseFilesContent("a.ts\n  b.ts  \n\nc.ts")).toEqual(["a.ts", "b.ts", "c.ts"]);
		});
		test("returns empty for empty input", () => {
			expect(parseFilesContent("")).toEqual([]);
		});
	});

	describe("hasUnreplacedPlaceholders", () => {
		test("true when body contains {{", () => {
			expect(hasUnreplacedPlaceholders("text {{foo}} more")).toBe(true);
		});
		test("false when no placeholders", () => {
			expect(hasUnreplacedPlaceholders("plain text")).toBe(false);
		});
	});

	describe("formatTitleBody", () => {
		test("joins title and body with double newline", () => {
			expect(formatTitleBody("feat: add x", "Body content")).toBe("feat: add x\n\nBody content");
		});
	});

	describe("inferTypeOfChange", () => {
		test("feat → New feature", () => {
			expect(inferTypeOfChange([commit("feat: x", "")])).toBe("New feature");
		});
		test("fix → Bug fix", () => {
			expect(inferTypeOfChange([commit("fix: y", "")])).toBe("Bug fix");
		});
		test("docs → Documentation update", () => {
			expect(inferTypeOfChange([commit("docs: z", "")])).toBe("Documentation update");
		});
		test("chore → Chore", () => {
			expect(inferTypeOfChange([commit("chore: a", "")])).toBe("Chore");
		});
		test("perf → Chore", () => {
			const commits = [commit("perf: speed up", "", { type: "perf" })];
			expect(inferTypeOfChange(commits)).toBe("Chore");
		});
		test("revert → Chore", () => {
			const commits = [commit("revert: undo feat", "", { type: "revert" })];
			expect(inferTypeOfChange(commits)).toBe("Chore");
		});
		test("BREAKING CHANGE in body → Breaking change", () => {
			expect(
				inferTypeOfChange([
					commit("feat: x", "BREAKING CHANGE: removed API", {
						breakingNote: "removed API",
					}),
				]),
			).toBe("Breaking change");
		});
		test("feat! → Breaking change", () => {
			expect(inferTypeOfChange([commit("feat!: x", "")])).toBe("Breaking change");
		});
		test("empty commits → Chore", () => {
			expect(inferTypeOfChange([])).toBe("Chore");
		});
		test("prTitle overrides first commit type (AI title vs newest commit)", () => {
			const commits = [
				commit("fix(ci): pass command via env", "", { type: "fix" }),
				commit("feat(generate-content): log model response", "", { type: "feat" }),
			];
			expect(inferTypeOfChange(commits)).toBe("Bug fix");
			expect(inferTypeOfChange(commits, "feat: improve CI and generate logging")).toBe(
				"New feature",
			);
		});
		test("prTitle with breaking marker → Breaking change", () => {
			const commits = [commit("fix: a", "", { type: "fix" })];
			expect(inferTypeOfChange(commits, "feat!: remove API")).toBe("Breaking change");
		});
		test("prTitle over max length but conventional still overrides type", () => {
			const commits = [commit("fix: a", "", { type: "fix" })];
			const longFeat = `feat: ${"x".repeat(FEAT_COLON_SUBJECT_OVER_MAX)}`;
			expect(longFeat.length).toBeGreaterThan(PR_TITLE_LINE_MAX_LENGTH);
			expect(inferTypeOfChange(commits, longFeat)).toBe("New feature");
		});
		test("prTitle with docs: prefix overrides first commit type", () => {
			const commits = [commit("fix: bug", "", { type: "fix" })];
			expect(inferTypeOfChange(commits, "docs: refresh README")).toBe("Documentation update");
		});
	});

	describe("getDescription", () => {
		test("uses body when not Closes/Fixes, collapses newlines within paragraph for PR", () => {
			const c = commit("feat: add x", "This adds the x feature.\nMore details.");
			expect(getDescription(c)).toBe("This adds the x feature. More details.");
		});
		test("preserves paragraph breaks (blank lines) in body", () => {
			const c = commit(
				"feat: add x",
				"First paragraph line one.\nFirst paragraph line two.\n\nSecond paragraph.",
			);
			expect(getDescription(c)).toBe(
				"First paragraph line one. First paragraph line two.\n\nSecond paragraph.",
			);
		});
		test("preserves bullet lists (remark AST)", () => {
			const c = commit(
				"feat: add x",
				"- Count only semantic commits\n- Move CI scripts to .github/scripts/\n- Sanitize GITHUB_OUTPUT",
			);
			const desc = getDescription(c);
			expect(desc).toContain("Count only semantic commits");
			expect(desc).toContain("Move CI scripts to .github/scripts/");
			expect(desc).toContain("Sanitize GITHUB");
		});
		test("preserves code blocks (remark AST)", () => {
			const c = commit("feat: add x", "Use:\n\n```\nPR_NUMBER=123 python script.py\n```");
			expect(getDescription(c)).toContain("Use:");
			expect(getDescription(c)).toContain("```");
			expect(getDescription(c)).toContain("PR_NUMBER=123 python script.py");
		});
		test("collapses prose but preserves mixed content", () => {
			const c = commit(
				"feat: add x",
				"Release Please force-pushes frequently, which was cancelling CI runs\nbefore they completed. Branch protection requires a successful check.\n\n- Set cancel-in-progress to false",
			);
			const desc = getDescription(c);
			expect(desc).toContain("Release Please force-pushes frequently");
			expect(desc).toContain("before they completed");
			expect(desc).toContain("Set cancel-in-progress to false");
		});
		test("uses subject after colon when body starts with Closes", () => {
			const c = commit("feat: add x", "Closes #123", { references: ["Closes #123"] });
			expect(getDescription(c)).toBe("add x");
		});
		test("returns subject when no body", () => {
			const c = commit("feat: add x", "");
			expect(getDescription(c)).toBe("add x");
		});
	});

	describe("getDescriptionFromCommits", () => {
		test("single commit: same as getDescription", () => {
			const commits = [commit("feat: add x", "This adds the x feature.")];
			expect(getDescriptionFromCommits(commits)).toBe("This adds the x feature.");
		});
		test("multiple commits: concatenates bodies with blank line separator", () => {
			const commits = [
				commit("feat: add A", "Adds module A."),
				commit("fix: fix B", "Fixes bug in B."),
			];
			expect(getDescriptionFromCommits(commits)).toBe("Adds module A.\n\nFixes bug in B.");
		});
		test("empty commits: empty string", () => {
			expect(getDescriptionFromCommits([])).toBe("");
		});
		test("skips Closes-only body, uses subject; concatenates with others", () => {
			const commits = [
				commit("feat: add foo", "Closes #1", { references: ["Closes #1"] }),
				commit("fix: fix bar", "Fix details here."),
			];
			expect(getDescriptionFromCommits(commits)).toBe("add foo\n\nFix details here.");
		});
	});

	describe("getDescriptionPromptText", () => {
		test("formats commits for AI prompt", () => {
			const commits = [
				commit("feat: add A", "Adds module A."),
				commit("fix: fix B", "Fixes bug in B."),
			];
			expect(getDescriptionPromptText(commits)).toBe(
				"- feat: add A\n\nAdds module A.\n\n- fix: fix B\n\nFixes bug in B.",
			);
		});
		test("commit with empty body: subject only", () => {
			const commits = [commit("feat: add x", "")];
			expect(getDescriptionPromptText(commits)).toBe("- feat: add x");
		});
	});

	describe("isMergeCommit", () => {
		test("Merge branch 'x' into y → true", () => {
			expect(isMergeCommit(commit("Merge branch 'x' into y", ""))).toBe(true);
		});
		test("Merge pull request #1 from org/repo → true", () => {
			expect(isMergeCommit(commit("Merge pull request #1 from org/repo", ""))).toBe(true);
		});
		test("feat: add x → false", () => {
			expect(isMergeCommit(commit("feat: add x", ""))).toBe(false);
		});
		test("merge commit with leading space → true", () => {
			expect(isMergeCommit(commit("  Merge branch 'x'", ""))).toBe(true);
		});
	});

	describe("filterMergeCommits", () => {
		test("excludes merge commits, keeps semantic", () => {
			const commits = [
				commit("feat: add foo", ""),
				commit("Merge branch 'main' into ai/foo", ""),
				commit("fix: typo", ""),
			];
			const filtered = filterMergeCommits(commits);
			expect(filtered).toHaveLength(2);
			expect(filtered[0]?.subject).toBe("feat: add foo");
			expect(filtered[1]?.subject).toBe("fix: typo");
		});
		test("all merge commits → empty", () => {
			const commits = [commit("Merge branch 'x'", ""), commit("Merge pull request #1", "")];
			expect(filterMergeCommits(commits)).toEqual([]);
		});
	});

	describe("getChanges", () => {
		test("one bullet per commit", () => {
			const commits = [commit("feat: a", ""), commit("fix: b", "")];
			expect(getChanges(commits)).toEqual(["- feat: a", "- fix: b"]);
		});
		test("includes non-conventional commits", () => {
			const commits = [
				commit("feat: conventional", "", { type: "feat" }),
				commit("wip: messy commit message", ""),
			];
			expect(getChanges(commits)).toEqual(["- feat: conventional", "- wip: messy commit message"]);
		});
		test("empty commits returns empty", () => {
			expect(getChanges([])).toEqual([]);
		});
	});

	describe("isDocsOnly", () => {
		test("empty files → true", () => {
			expect(isDocsOnly([])).toBe(true);
		});
		test("only .md files → true", () => {
			expect(isDocsOnly(["README.md", "docs/a.md"])).toBe(true);
		});
		test("mixed files → false", () => {
			expect(isDocsOnly(["README.md", "src/foo.ts"])).toBe(false);
		});
	});

	describe("hasTestFiles", () => {
		test("no test files → false", () => {
			expect(hasTestFiles(["src/foo.ts"])).toBe(false);
		});
		test("test/ in path → true", () => {
			expect(hasTestFiles(["test/foo.test.ts"])).toBe(true);
		});
		test(".test.ts suffix → true", () => {
			expect(hasTestFiles(["foo.test.ts"])).toBe(true);
		});
		test(".spec.ts suffix → true", () => {
			expect(hasTestFiles(["foo.spec.ts"])).toBe(true);
		});
		test("spec/ in path → true", () => {
			expect(hasTestFiles(["spec/foo.spec.ts"])).toBe(true);
		});
		test("testament.ts not a test file → false", () => {
			expect(hasTestFiles(["src/testament.ts"])).toBe(false);
		});
	});

	describe("hasDocsFiles", () => {
		test("no docs → false", () => {
			expect(hasDocsFiles(["src/foo.ts"])).toBe(false);
		});
		test(".md file → true", () => {
			expect(hasDocsFiles(["README.md"])).toBe(true);
		});
		test("docs/ prefix → true", () => {
			expect(hasDocsFiles(["docs/guide.md"])).toBe(true);
		});
	});

	describe("isConventional", () => {
		test("feat: x → true", () => {
			expect(isConventional(commit("feat: add foo", "", { type: "feat" }))).toBe(true);
		});
		test("fix(scope): x → true", () => {
			expect(isConventional(commit("fix(api): handle error", "", { type: "fix" }))).toBe(true);
		});
		test("plain message → false", () => {
			expect(isConventional(commit("just some message", ""))).toBe(false);
		});
	});

	describe("getRelatedIssues", () => {
		test("extracts Closes #123", () => {
			const commits = [commit("x", "Closes #123", { references: ["Closes #123"] })];
			expect(getRelatedIssues(commits)).toEqual(["Closes #123"]);
		});
		test("extracts Fixes #456", () => {
			const commits = [commit("x", "Fixes #456", { references: ["Fixes #456"] })];
			expect(getRelatedIssues(commits)).toEqual(["Fixes #456"]);
		});
		test("extracts Resolves #789", () => {
			const commits = [commit("x", "Resolves #789", { references: ["Resolves #789"] })];
			expect(getRelatedIssues(commits)).toEqual(["Resolves #789"]);
		});
		test("deduplicates", () => {
			const commits = [
				commit("x", "Closes #1", { references: ["Closes #1"] }),
				commit("y", "Closes #1", { references: ["Closes #1"] }),
			];
			expect(getRelatedIssues(commits)).toEqual(["Closes #1"]);
		});
	});

	describe("getBreakingChanges", () => {
		test("no BREAKING CHANGE → none", () => {
			expect(Option.isNone(getBreakingChanges([commit("feat: x", "")]))).toBe(true);
		});
		test("BREAKING CHANGE in body → some", () => {
			pipe(
				getBreakingChanges([
					commit("feat: x", "BREAKING CHANGE: removed old API", {
						breakingNote: "removed old API",
					}),
				]),
				Option.match({
					onNone: () => expect().fail("expected some"),
					onSome: (text) => expect(text).toBe("removed old API"),
				}),
			);
		});
		test("truncates breaking note to 2000 chars", () => {
			const longNote = "x".repeat(2500);
			pipe(
				getBreakingChanges([commit("feat: x", "BREAKING CHANGE", { breakingNote: longNote })]),
				Option.match({
					onNone: () => expect().fail("expected some"),
					onSome: (text) => expect(text.length).toBe(2000),
				}),
			);
		});
		test("joins multiple BREAKING CHANGE footers in commit order", () => {
			pipe(
				getBreakingChanges([
					commit("a", "", { breakingNote: "First" }),
					commit("b", "", { breakingNote: "Second" }),
				]),
				Option.match({
					onNone: () => expect().fail("expected some"),
					onSome: (text) => expect(text).toBe("First\n\nSecond"),
				}),
			);
		});
	});

	describe("extractBreakingDescriptionFromLine", () => {
		test("feat!: subject → description after colon", () => {
			pipe(
				extractBreakingDescriptionFromLine("feat!: remove legacy API"),
				Option.match({
					onNone: () => expect().fail("expected some"),
					onSome: (s) => expect(s).toBe("remove legacy API"),
				}),
			);
		});
		test("scoped breaking header → description after colon", () => {
			pipe(
				extractBreakingDescriptionFromLine("feat(api)!: drop v1"),
				Option.match({
					onNone: () => expect().fail("expected some"),
					onSome: (s) => expect(s).toBe("drop v1"),
				}),
			);
		});
		test("line starting with BREAKING → full line", () => {
			pipe(
				extractBreakingDescriptionFromLine("BREAKING: all clients must migrate"),
				Option.match({
					onNone: () => expect().fail("expected some"),
					onSome: (s) => expect(s).toBe("BREAKING: all clients must migrate"),
				}),
			);
		});
		test("non-breaking conventional title → none", () => {
			expect(Option.isNone(extractBreakingDescriptionFromLine("feat: add x"))).toBe(true);
		});
	});

	describe("resolveBreakingChangesBody", () => {
		test("prefers footers over title and subjects", () => {
			const commits = [commit("feat!: ignored", "", { type: "feat", breakingNote: "From footer" })];
			expect(resolveBreakingChangesBody(commits, "feat!: from title")).toBe("From footer");
		});
		test("uses breaking PR title when no footers", () => {
			const commits = [commit("fix: prep", "", { type: "fix" })];
			expect(resolveBreakingChangesBody(commits, "feat!: rollup breaking change")).toBe(
				"rollup breaking change",
			);
		});
		test("concatenates breaking subjects when no footers and title not breaking", () => {
			const commits = [
				commit("feat!: remove A", "", { type: "feat" }),
				commit("feat!: remove B", "", { type: "feat" }),
			];
			expect(resolveBreakingChangesBody(commits, undefined)).toBe("remove A\n\nremove B");
		});
	});

	describe("fillTemplate", () => {
		test("empty commits produces minimal data", () => {
			const data = fillTemplate([], []);
			expect(data.description).toBe("");
			expect(data.typeOfChange).toBe("Chore");
			expect(data.changes).toEqual(["- "]);
		});
		test("docs-only files → succeeds", () => {
			const commits = [commit("docs: x", "")];
			const data = fillTemplate(commits, ["README.md"]);
			expect(data.typeOfChange).toBe("Documentation update");
		});
		test("code files → succeeds", () => {
			const commits = [commit("feat: x", "")];
			const data = fillTemplate(commits, ["src/foo.ts"]);
			expect(data.typeOfChange).toBe("New feature");
		});
		test("commitsConventional false when any commit is non-conventional", () => {
			const commits = [commit("feat: a", "", { type: "feat" }), commit("random message", "")];
			const data = fillTemplate(commits, []);
			expect(data.commitsConventional).toBe(false);
		});
		test("commitsConventional true when all commits are conventional", () => {
			const commits = [
				commit("feat: a", "", { type: "feat" }),
				commit("fix: b", "", { type: "fix" }),
			];
			const data = fillTemplate(commits, []);
			expect(data.commitsConventional).toBe(true);
		});
		test("multi-commit: description concatenates all commit bodies", () => {
			const commits = [
				commit("feat: add A", "Adds module A with tests.", { type: "feat" }),
				commit("fix: fix B", "Fixes null check in B.", { type: "fix" }),
			];
			const data = fillTemplate(commits, []);
			expect(data.description).toBe("Adds module A with tests.\n\nFixes null check in B.");
		});
		test("descriptionOverride overrides computed description", () => {
			const commits = [commit("feat: add x", "Original body", { type: "feat" })];
			const data = fillTemplate(commits, [], "AI-generated summary.");
			expect(data.description).toBe("AI-generated summary.");
		});
		test("prTitleForTypeOfChange aligns typeOfChange with final PR title", () => {
			const commits = [commit("fix: first in log", "", { type: "fix" })];
			const data = fillTemplate(commits, [], "Summary.", "feat: rolled-up title");
			expect(data.typeOfChange).toBe("New feature");
		});
		test("feat!: without footer fills breakingChanges from subject", () => {
			const commits = [commit("feat!: drop legacy API", "", { type: "feat" })];
			const data = fillTemplate(commits, []);
			expect(data.typeOfChange).toBe("Breaking change");
			expect(data.breakingChanges).toBe("drop legacy API");
		});
		test("prTitleForTypeOfChange breaking title fills breakingChanges when no footers", () => {
			const commits = [commit("fix: small fix", "", { type: "fix" })];
			const data = fillTemplate(commits, [], undefined, "feat!: migrate to new API");
			expect(data.typeOfChange).toBe("Breaking change");
			expect(data.breakingChanges).toBe("migrate to new API");
		});
	});

	describe("matchesConventionalTitleFormat", () => {
		test("accepts conventional-shaped titles regardless of length", () => {
			expect(matchesConventionalTitleFormat("feat: add X")).toBe(true);
			expect(matchesConventionalTitleFormat("fix(ci): resolve bug")).toBe(true);
			expect(matchesConventionalTitleFormat(`fix(ci): ${"a".repeat(80)}`)).toBe(true);
		});
		test("rejects non-matching titles", () => {
			expect(matchesConventionalTitleFormat("")).toBe(false);
			expect(matchesConventionalTitleFormat("Add feature X")).toBe(false);
			expect(matchesConventionalTitleFormat(" : missing type")).toBe(false);
		});
	});

	describe("isWithinLengthLimit", () => {
		test("accepts non-blank titles up to max length trimmed", () => {
			expect(isWithinLengthLimit("feat: add X")).toBe(true);
			expect(
				isWithinLengthLimit(`feat: ${"a".repeat(PR_TITLE_LINE_MAX_LENGTH - "feat: ".length)}`),
			).toBe(true);
			expect(isWithinLengthLimit(`feat: ${"a".repeat(FEAT_COLON_SUBJECT_OVER_MAX)}`)).toBe(false);
		});
		test("rejects blank", () => {
			expect(isWithinLengthLimit("")).toBe(false);
			expect(isWithinLengthLimit("  ")).toBe(false);
		});
	});

	describe("isValidConventionalTitle", () => {
		test("accepts valid conventional titles", () => {
			expect(isValidConventionalTitle("feat: add X")).toBe(true);
			expect(isValidConventionalTitle("fix(ci): resolve bug")).toBe(true);
			expect(isValidConventionalTitle("docs: update README")).toBe(true);
			expect(isValidConventionalTitle("feat!: breaking change")).toBe(true);
			expect(isValidConventionalTitle("feat(scope)!: breaking")).toBe(true);
		});
		test("rejects invalid titles", () => {
			expect(isValidConventionalTitle("")).toBe(false);
			expect(isValidConventionalTitle("Add feature X")).toBe(false);
			expect(isValidConventionalTitle("Here's the title: feat: add X")).toBe(false);
			expect(isValidConventionalTitle("  ")).toBe(false);
			expect(isValidConventionalTitle(`feat: ${"a".repeat(FEAT_COLON_SUBJECT_OVER_MAX)}`)).toBe(
				false,
			);
			expect(isValidConventionalTitle(" : missing type")).toBe(false);
		});
	});

	describe("fitConventionalTitleToLengthLimit", () => {
		test("leaves short conventional titles unchanged", () => {
			Result.match(fitConventionalTitleToLengthLimit("feat: add X"), {
				onSuccess: (t) => expect(t).toBe("feat: add X"),
				onFailure: () => expect().fail("expected success"),
			});
		});
		test("shortens subject to satisfy max length", () => {
			const long = `feat: ${"a".repeat(FEAT_COLON_SUBJECT_OVER_MAX)}`;
			expect(long.length).toBeGreaterThan(PR_TITLE_LINE_MAX_LENGTH);
			Result.match(fitConventionalTitleToLengthLimit(long), {
				onSuccess: (t) => {
					expect(t.length).toBe(PR_TITLE_LINE_MAX_LENGTH);
					expect(isValidConventionalTitle(t)).toBe(true);
				},
				onFailure: () => expect().fail("expected success"),
			});
		});
		test("shortens scoped titles", () => {
			const prefix = "feat(ci): ";
			const long = `${prefix}${"b".repeat(PR_TITLE_LINE_MAX_LENGTH - prefix.length + 1)}`;
			Result.match(fitConventionalTitleToLengthLimit(long), {
				onSuccess: (t) => {
					expect(t.length).toBe(PR_TITLE_LINE_MAX_LENGTH);
					expect(matchesConventionalTitleFormat(t)).toBe(true);
				},
				onFailure: () => expect().fail("expected success"),
			});
		});
		test("fails for non-conventional titles", () => {
			Result.match(fitConventionalTitleToLengthLimit("not conventional"), {
				onSuccess: () => expect().fail("expected failure"),
				onFailure: () => {},
			});
		});
		test("fails when conventional header is too long to leave room for subject", () => {
			const scope = "a".repeat(92);
			const title = `feat(${scope}): x`;
			const prefixLen = `feat(${scope}): `.length;
			expect(prefixLen).toBe(PR_TITLE_LINE_MAX_LENGTH);
			expect(title.length).toBeGreaterThan(PR_TITLE_LINE_MAX_LENGTH);
			Result.match(fitConventionalTitleToLengthLimit(title), {
				onSuccess: () => expect().fail("expected failure"),
				onFailure: (e) => {
					expect(e.cause).toContain("cannot be shortened");
				},
			});
		});
		test("fails when shortened slice is whitespace-only (trimEnd)", () => {
			// Prefix 6 + 94 spaces + "x" → trim does not collapse; first 94 chars of subject are spaces only.
			const title = `feat: ${" ".repeat(94)}x`;
			expect(title.length).toBeGreaterThan(PR_TITLE_LINE_MAX_LENGTH);
			Result.match(fitConventionalTitleToLengthLimit(title), {
				onSuccess: () => expect().fail("expected failure"),
				onFailure: (e) => {
					expect(e.cause).toContain("no usable subject");
				},
			});
		});
	});

	describe("validateTitleDescription", () => {
		test("succeeds for valid title and description", () => {
			Result.match(
				validateTitleDescription({ title: "feat: add X", description: "Summary here." }),
				{
					onSuccess: (v) => {
						expect(v.title).toBe("feat: add X");
						expect(v.description).toBe("Summary here.");
					},
					onFailure: () => expect().fail("expected success"),
				},
			);
		});
		test("fails for blank title", () => {
			Result.match(validateTitleDescription({ title: "", description: "Body" }), {
				onSuccess: () => expect().fail("expected failure"),
				onFailure: () => {},
			});
			Result.match(validateTitleDescription({ title: "  ", description: "Body" }), {
				onSuccess: () => expect().fail("expected failure"),
				onFailure: () => {},
			});
		});
		test("fails for blank description", () => {
			Result.match(validateTitleDescription({ title: "feat: x", description: "" }), {
				onSuccess: () => expect().fail("expected failure"),
				onFailure: () => {},
			});
		});
		test("fails for non-conventional title", () => {
			Result.match(validateTitleDescription({ title: "Add feature", description: "Body" }), {
				onSuccess: () => expect().fail("expected failure"),
				onFailure: () => {},
			});
		});
		test("shortens long conventional title to max length", () => {
			const longTitle = `feat: ${"x".repeat(FEAT_COLON_SUBJECT_OVER_MAX)}`;
			Result.match(validateTitleDescription({ title: longTitle, description: "Summary here." }), {
				onSuccess: (v) => {
					expect(v.title.length).toBe(PR_TITLE_LINE_MAX_LENGTH);
					expect(v.description).toBe("Summary here.");
				},
				onFailure: () => expect().fail("expected success"),
			});
		});
	});

	describe("renderBody", () => {
		test("output contains all sections", () => {
			const commits = [commit("feat: add x", "Description here", { type: "feat" })];
			Result.match(renderBody(commits, ["src/foo.ts"], TEST_TEMPLATE, undefined), {
				onSuccess: (out) => {
					expect(out).toContain("## Description");
					expect(out).toContain("## Type of change");
					expect(out).toContain("## Changes made");
					expect(out).toContain("## How to test");
					expect(out).toContain("## Checklist");
					expect(out).toContain("New feature");
					expect(out).toContain("Description here");
					expect(out).toContain("Run the relevant tests or checks");
				},
				onFailure: () => expect().fail("expected success"),
			});
		});

		test("preserves literal {{ and }} in description", () => {
			const commits = [commit("feat: add x", "Use {{ and }} in your code", { type: "feat" })];
			Result.match(renderBody(commits, ["src/foo.ts"], TEST_TEMPLATE, undefined), {
				onSuccess: (out) => expect(out).toContain("Use {{ and }} in your code"),
				onFailure: () => expect().fail("expected success"),
			});
		});
	});
});
