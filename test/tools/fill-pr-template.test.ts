import { describe, expect, layer, test } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, pipe, Result } from "effect";
import { Command } from "effect/unstable/cli";
import { FillPrTemplate, renderBody } from "#auto-pr";
import type { CommitInfo } from "#lib/fill-pr-template-core.js";
import {
	fillTemplate,
	filterMergeCommits,
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
	parseCommits,
	parseFilesContent,
	renderBody as renderBodyCore,
} from "#lib/fill-pr-template-core.js";
import { createTestTempDirEffect, SilentLoggerLayer, TestBaseLayer } from "#test/test-utils.js";
import {
	CliLayer,
	fillCommand,
	handleOutputDescriptionPrompt,
	handleValidateTitle,
	runFillBody,
} from "#tools/fill-pr-template.js";
import pkg from "../../package.json" with { type: "json" };

// Required by FillPrTemplateConfigLayer when running CLI in-process
process.env.AUTO_PR_HOW_TO_TEST ??= "1. Run tests";

const TEST_TEMPLATE = `## Description
{{description}}

## Type of change
**{{typeOfChange}}**. See [Conventional Commits](https://www.conventionalcommits.org/).

## Changes made
{{changes}}

## How to test
{{howToTest}}

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

/** Format commit blocks for parseCommits (---COMMIT--- separated). */
function logContent(...blocks: Array<{ subject: string; body: string }>): string {
	const formatted = blocks.map((b) => (b.body ? `${b.subject}\n\n${b.body}`.trim() : b.subject));
	return `---COMMIT---\n${formatted.join("\n---COMMIT---\n")}`;
}

const DEFAULT_HOW_TO_TEST = "1. Run `npm run check`\n2. ";

/** Write log and files to temp dir, run runFillBody, return output. No git. */
function runWithLogAndFilesEffect(
	logStr: string,
	filesStr: string,
	opts?: {
		templatePath?: string;
		format?: "body" | "title-body";
		howToTestDefault?: string;
	},
): Effect.Effect<string, Error> {
	return Effect.gen(function* () {
		const tmp = yield* createTestTempDirEffect("fill-pr-template-");
		const templatePath = opts?.templatePath ?? tmp.join("template.md");
		if (opts?.templatePath === undefined) {
			yield* tmp.writeFile(templatePath, TEST_TEMPLATE);
		}
		return yield* Effect.gen(function* () {
			yield* tmp.writeFile(tmp.join("commits.txt"), logStr);
			yield* tmp.writeFile(tmp.join("files.txt"), filesStr);
			return yield* runFillBody(
				tmp.join("commits.txt"),
				tmp.join("files.txt"),
				templatePath,
				opts?.format ?? "body",
				opts?.howToTestDefault ?? DEFAULT_HOW_TO_TEST,
			);
		}).pipe(Effect.ensuring(tmp.remove()));
	}).pipe(Effect.provide(TestBaseLayer), Effect.provide(FillPrTemplate.Live));
}

// ─── Pure function tests ────────────────────────────────────────────────────

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
				onFailure: () => expect.fail("expected success"),
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
				onFailure: () => expect.fail("expected success"),
			}),
		);
	});

	test("returns empty for empty input", () => {
		pipe(
			parseCommits(""),
			Result.match({
				onSuccess: (commits) => expect(commits).toEqual([]),
				onFailure: () => expect.fail("expected success"),
			}),
		);
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
		expect(desc).toContain("Sanitize GITHUB"); // remark may escape _ in OUTPUT
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
	test("formats commits for Ollama prompt", () => {
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
				onNone: () => expect.fail("expected some"),
				onSome: (text) => expect(text).toBe("removed old API"),
			}),
		);
	});

	test("truncates breaking note to 2000 chars", () => {
		const longNote = "x".repeat(2500);
		pipe(
			getBreakingChanges([commit("feat: x", "BREAKING CHANGE", { breakingNote: longNote })]),
			Option.match({
				onNone: () => expect.fail("expected some"),
				onSome: (text) => expect(text.length).toBe(2000),
			}),
		);
	});
});

describe("fillTemplate", () => {
	test("empty commits produces minimal data", () => {
		Result.match(fillTemplate([], []), {
			onSuccess: (data) => {
				expect(data.description).toBe("");
				expect(data.typeOfChange).toBe("Chore");
				expect(data.changes).toEqual(["- "]);
				expect(data.howToTest).toBe("N/A");
			},
			onFailure: () => expect.fail("expected success"),
		});
	});

	test("docs-only files → howToTest N/A", () => {
		const commits = [commit("docs: x", "")];
		Result.match(fillTemplate(commits, ["README.md"]), {
			onSuccess: (data) => expect(data.howToTest).toBe("N/A"),
			onFailure: () => expect.fail("expected success"),
		});
	});

	test("code files → howToTest has steps", () => {
		const commits = [commit("feat: x", "")];
		Result.match(fillTemplate(commits, ["src/foo.ts"], undefined, "1. Run `npm run check`\n2. "), {
			onSuccess: (data) => expect(data.howToTest).toContain("npm run check"),
			onFailure: () => expect.fail("expected success"),
		});
	});

	test("commitsConventional false when any commit is non-conventional", () => {
		const commits = [commit("feat: a", "", { type: "feat" }), commit("random message", "")];
		Result.match(fillTemplate(commits, [], undefined, "1. Run tests"), {
			onSuccess: (data) => expect(data.commitsConventional).toBe(false),
			onFailure: () => expect.fail("expected success"),
		});
	});

	test("commitsConventional true when all commits are conventional", () => {
		const commits = [
			commit("feat: a", "", { type: "feat" }),
			commit("fix: b", "", { type: "fix" }),
		];
		Result.match(fillTemplate(commits, [], undefined, "1. Run tests"), {
			onSuccess: (data) => expect(data.commitsConventional).toBe(true),
			onFailure: () => expect.fail("expected success"),
		});
	});

	test("multi-commit: description concatenates all commit bodies", () => {
		const commits = [
			commit("feat: add A", "Adds module A with tests.", { type: "feat" }),
			commit("fix: fix B", "Fixes null check in B.", { type: "fix" }),
		];
		Result.match(fillTemplate(commits, [], undefined, "1. Run tests"), {
			onSuccess: (data) =>
				expect(data.description).toBe("Adds module A with tests.\n\nFixes null check in B."),
			onFailure: () => expect.fail("expected success"),
		});
	});

	test("descriptionOverride overrides computed description", () => {
		const commits = [commit("feat: add x", "Original body", { type: "feat" })];
		Result.match(fillTemplate(commits, [], "Ollama-generated summary.", "1. Run tests"), {
			onSuccess: (data) => expect(data.description).toBe("Ollama-generated summary."),
			onFailure: () => expect.fail("expected success"),
		});
	});

	test("howToTestDefault overrides default for non-docs-only", () => {
		const commits = [commit("feat: add x", "", { type: "feat" })];
		Result.match(fillTemplate(commits, ["src/foo.ts"], undefined, "1. Run `pytest`\n2. "), {
			onSuccess: (data) => expect(data.howToTest).toBe("1. Run `pytest`\n2. "),
			onFailure: () => expect.fail("expected success"),
		});
	});

	test("fails when howToTestDefault required but absent (not docs-only)", () => {
		const commits = [commit("feat: add x", "", { type: "feat" })];
		Result.match(fillTemplate(commits, ["src/foo.ts"]), {
			onSuccess: () => expect.fail("expected failure"),
			onFailure: (e) => expect(e.message).toContain("howToTestDefault is required"),
		});
	});
});

const RENDER_HOW_TO_TEST = "1. Run `npm run check`\n2. ";

layer(SilentLoggerLayer)("renderBody", (it) => {
	it.effect("returns rendered body when all placeholders replaced", () =>
		Effect.gen(function* () {
			const commits = [commit("feat: add x", "Description here", { type: "feat" })];
			const files = ["src/foo.ts"];
			const body = yield* renderBody(commits, files, TEST_TEMPLATE, undefined, RENDER_HOW_TO_TEST);
			expect(body).toContain("## Description");
			expect(body).toContain("Description here");
			expect(body).not.toContain("{{description}}");
		}),
	);

	it.effect("returns body and logs warning when output contains {{", () =>
		Effect.gen(function* () {
			const commits = [commit("feat: add x", "Use {{ and }} in your code", { type: "feat" })];
			const files = ["src/foo.ts"];
			const body = yield* renderBody(commits, files, TEST_TEMPLATE, undefined, RENDER_HOW_TO_TEST);
			expect(body).toContain("Use {{ and }} in your code");
			expect(body).toContain("{{");
		}),
	);
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
		expect(isValidConventionalTitle(`feat: ${"a".repeat(67)}`)).toBe(false);
		expect(isValidConventionalTitle(" : missing type")).toBe(false);
	});
});

describe("renderBody (pure)", () => {
	const RENDER_CORE_HOW_TO_TEST = "1. Run `npm run check`\n2. ";

	test("output contains all sections", () => {
		const commits = [commit("feat: add x", "Description here", { type: "feat" })];
		Result.match(
			renderBodyCore(commits, ["src/foo.ts"], TEST_TEMPLATE, undefined, RENDER_CORE_HOW_TO_TEST),
			{
				onSuccess: (out) => {
					expect(out).toContain("## Description");
					expect(out).toContain("## Type of change");
					expect(out).toContain("## Changes made");
					expect(out).toContain("## How to test");
					expect(out).toContain("## Checklist");
					expect(out).toContain("New feature");
					expect(out).toContain("Description here");
				},
				onFailure: () => expect.fail("expected success"),
			},
		);
	});

	test("preserves literal {{ and }} in description", () => {
		const commits = [commit("feat: add x", "Use {{ and }} in your code", { type: "feat" })];
		Result.match(
			renderBodyCore(commits, ["src/foo.ts"], TEST_TEMPLATE, undefined, RENDER_CORE_HOW_TO_TEST),
			{
				onSuccess: (out) => expect(out).toContain("Use {{ and }} in your code"),
				onFailure: () => expect.fail("expected success"),
			},
		);
	});
});

// ─── runFillBody (file-based pipeline) tests ─────────────────────────────────

const RunFillBodyTestLayer = Layer.mergeAll(TestBaseLayer, FillPrTemplate.Live);

layer(RunFillBodyTestLayer)("runFillBody", (it) => {
	it.effect("produces full PR body from log and files", () =>
		Effect.gen(function* () {
			const log = logContent({ subject: "feat: add foo", body: "This adds the foo module." });
			const output = yield* runWithLogAndFilesEffect(log, "src/foo.ts\n");
			expect(output).toContain("## Description");
			expect(output).toContain("## Type of change");
			expect(output).toContain("## Changes made");
			expect(output).toContain("New feature");
			expect(output).toContain("feat: add foo");
			expect(output).toContain("This adds the foo module");
			expect(output).toContain("npm run check");
		}),
	);

	it.effect("title-body format: first line is title (first commit subject)", () =>
		Effect.gen(function* () {
			const log = logContent({ subject: "feat(ci): add PR title generation", body: "" });
			const output = yield* runWithLogAndFilesEffect(log, "src/ci.ts\n", {
				format: "title-body",
			});
			const lines = output.split("\n");
			expect(lines[0]).toBe("feat(ci): add PR title generation");
			expect(lines[1]).toBe("");
			expect(output).toContain("## Description");
		}),
	);

	it.effect("multi-commit: body includes all commits, title from first (newest)", () =>
		Effect.gen(function* () {
			const log = logContent(
				{ subject: "feat: add module B", body: "" },
				{ subject: "feat: add module A", body: "" },
			);
			const output = yield* runWithLogAndFilesEffect(log, "src/a.ts\nsrc/b.ts\n", {
				format: "title-body",
			});
			expect(output.split("\n")[0]).toBe("feat: add module B");
			expect(output).toContain("feat: add module A");
			expect(output).toContain("feat: add module B");
			expect(output).toContain("## Changes made");
		}),
	);

	it.effect("multi-commit: description concatenates all commit bodies", () =>
		Effect.gen(function* () {
			const log = logContent(
				{ subject: "feat: add A", body: "Adds module A." },
				{ subject: "fix: fix B", body: "Fixes bug in B." },
			);
			const output = yield* runWithLogAndFilesEffect(log, "src/a.ts\nsrc/b.ts\n");
			expect(output).toContain("Adds module A.");
			expect(output).toContain("Fixes bug in B.");
			expect(output).toContain("## Description");
		}),
	);

	it.effect("--description-file overrides computed description", () =>
		Effect.gen(function* () {
			const tmp = yield* createTestTempDirEffect("fill-pr-template-");
			return yield* Effect.gen(function* () {
				const log = logContent({ subject: "feat: add x", body: "Original body" });
				yield* tmp.writeFile(tmp.join("commits.txt"), log);
				yield* tmp.writeFile(tmp.join("files.txt"), "src/foo.ts\n");
				yield* tmp.writeFile(tmp.join("template.md"), TEST_TEMPLATE);
				yield* tmp.writeFile(tmp.join("description.txt"), "Ollama-generated summary.");
				const output = yield* runFillBody(
					tmp.join("commits.txt"),
					tmp.join("files.txt"),
					tmp.join("template.md"),
					"body",
					DEFAULT_HOW_TO_TEST,
					tmp.join("description.txt"),
				);
				expect(output).toContain("Ollama-generated summary.");
				expect(output).not.toContain("Original body");
				return output;
			}).pipe(Effect.ensuring(tmp.remove()));
		}),
	);

	it.effect("filters merge commits, includes non-conventional", () =>
		Effect.gen(function* () {
			const log = logContent(
				{ subject: "feat: add foo", body: "" },
				{ subject: "Merge branch 'main' into ai/merge-test", body: "" },
				{ subject: "wip: messy commit", body: "" },
				{ subject: "feat: add y", body: "" },
			);
			const output = yield* runWithLogAndFilesEffect(log, "src/foo.ts\nsrc/y.ts\n", {
				format: "title-body",
			});
			expect(output).toContain("feat: add foo");
			expect(output).toContain("wip: messy commit");
			expect(output).toContain("feat: add y");
			expect(output).not.toContain("Merge branch");
		}),
	);

	it.effect("extracts Closes #42, docs-only → howToTest N/A", () =>
		Effect.gen(function* () {
			const log = logContent({ subject: "docs: update guide", body: "Closes #42" });
			const output = yield* runWithLogAndFilesEffect(log, "docs/guide.md\n");
			expect(output).toContain("Closes #42");
			expect(output).toContain("Documentation update");
			expect(output).toContain("N/A");
		}),
	);

	it.effect("uses custom template when path provided", () =>
		Effect.gen(function* () {
			const tmp = yield* createTestTempDirEffect("fill-pr-template-");
			return yield* Effect.gen(function* () {
				yield* tmp.writeFile(
					tmp.join("custom.md"),
					"Custom: {{description}}\nType: {{typeOfChange}}\n{{changes}}",
				);
				const log = logContent({ subject: "feat: add bar", body: "Bar feature here." });
				yield* tmp.writeFile(tmp.join("commits.txt"), log);
				yield* tmp.writeFile(tmp.join("files.txt"), "src/bar.ts\n");
				const output = yield* runFillBody(
					tmp.join("commits.txt"),
					tmp.join("files.txt"),
					tmp.join("custom.md"),
					"body",
					DEFAULT_HOW_TO_TEST,
				);
				expect(output).toContain("Custom: Bar feature here.");
				expect(output).toContain("Type: New feature");
				expect(output).toContain("feat: add bar");
				return output;
			}).pipe(Effect.ensuring(tmp.remove()));
		}),
	);

	it.effect("fails when log file not found", () =>
		Effect.gen(function* () {
			const tmp = yield* createTestTempDirEffect("fill-pr-template-");
			return yield* Effect.gen(function* () {
				yield* tmp.writeFile(tmp.join("template.md"), TEST_TEMPLATE);
				yield* tmp.writeFile(tmp.join("files.txt"), "src/foo.ts\n");
				const err = yield* runFillBody(
					tmp.join("nonexistent.txt"),
					tmp.join("files.txt"),
					tmp.join("template.md"),
					"body",
					DEFAULT_HOW_TO_TEST,
				).pipe(Effect.flip);
				const msg = err instanceof Error ? err.message : String(err);
				expect(
					msg.includes("Log file not found") ||
						msg.includes("nonexistent") ||
						msg.includes("File system error"),
				).toBe(true);
				return err;
			}).pipe(Effect.ensuring(tmp.remove()));
		}),
	);

	it.effect("fails when no commits (empty title in title-body format)", () =>
		Effect.gen(function* () {
			const err = yield* runWithLogAndFilesEffect("", "", { format: "title-body" }).pipe(
				Effect.flip,
			);
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("PR title is empty");
		}),
	);
});

// ─── handleValidateTitle / handleOutputDescriptionPrompt ─────────────────────

layer(Layer.mergeAll(TestBaseLayer))("handleValidateTitle", (it) => {
	it.effect("succeeds for valid conventional title", () => handleValidateTitle("feat: add x"));
	it.effect("succeeds for valid scoped title", () => handleValidateTitle("fix(ci): resolve bug"));
	it.effect("fails for invalid title", () =>
		Effect.gen(function* () {
			const err = yield* handleValidateTitle("not conventional").pipe(Effect.flip);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toBe("Invalid conventional commit title");
		}),
	);
});

layer(Layer.mergeAll(TestBaseLayer))("handleOutputDescriptionPrompt", (it) => {
	it.effect("outputs description prompt from log file", () =>
		Effect.gen(function* () {
			const tmp = yield* createTestTempDirEffect("fill-pr-output-prompt-");
			const log = logContent(
				{ subject: "feat: add foo", body: "Feature body here." },
				{ subject: "fix: fix bar", body: "Fix body." },
			);
			yield* tmp.writeFile(tmp.join("commits.txt"), log);
			yield* handleOutputDescriptionPrompt(tmp.join("commits.txt"), true).pipe(
				Effect.provide(TestBaseLayer),
			);
			return yield* tmp.remove();
		}).pipe(Effect.scoped),
	);
});

// ─── CLI error paths (in-process via Command.runWith) ─────────────────────────────────

function runCliWithArgs(args: string[]): Effect.Effect<void, unknown, never> {
	return Command.runWith(fillCommand, { version: pkg.version })(args).pipe(
		Effect.provide(CliLayer),
	);
}

layer(Layer.empty)("fill-pr-template CLI", (it) => {
	const runCli = (args: string[]) => runCliWithArgs(args).pipe(Effect.exit);

	it.effect("--validate-title valid exits 0", () =>
		Effect.gen(function* () {
			const exit = yield* runCli(["--validate-title", "feat: add x"]);
			expect(Exit.isSuccess(exit)).toBe(true);
		}),
	);

	it.effect("--validate-title invalid exits 1", () =>
		Effect.gen(function* () {
			const exit = yield* runCli(["--validate-title", "invalid title"]);
			expect(Exit.isFailure(exit)).toBe(true);
			const msg = Exit.match(exit, {
				onSuccess: () => "",
				onFailure: (cause) => Option.getOrElse(Cause.findErrorOption(cause), () => String(cause)),
			});
			expect(msg instanceof Error ? msg.message : msg).toContain(
				"Invalid conventional commit title",
			);
		}),
	);

	it.effect("--output-description-prompt without --log-file exits 1", () =>
		Effect.gen(function* () {
			const exit = yield* runCli(["--output-description-prompt"]);
			expect(Exit.isFailure(exit)).toBe(true);
			const msg = Exit.match(exit, {
				onSuccess: () => "",
				onFailure: (cause) => Option.getOrElse(Cause.findErrorOption(cause), () => String(cause)),
			});
			expect(msg instanceof Error ? msg.message : msg).toContain("--log-file");
		}),
	);

	it.effect("--format required when filling", () =>
		Effect.gen(function* () {
			const exit = yield* runCli([
				"--log-file",
				"/tmp/x",
				"--files-file",
				"/tmp/y",
				"--template",
				"/tmp/z",
			]);
			expect(Exit.isFailure(exit)).toBe(true);
			const msg = Exit.match(exit, {
				onSuccess: () => "",
				onFailure: (cause) => Option.getOrElse(Cause.findErrorOption(cause), () => String(cause)),
			});
			expect(msg instanceof Error ? msg.message : msg).toContain("--format");
		}),
	);

	it.effect("--format invalid value exits 1", () =>
		Effect.gen(function* () {
			const exit = yield* runCli([
				"--log-file",
				"/tmp/x",
				"--files-file",
				"/tmp/y",
				"--template",
				"/tmp/z",
				"--format",
				"invalid",
			]);
			expect(Exit.isFailure(exit)).toBe(true);
			const msg = Exit.match(exit, {
				onSuccess: () => "",
				onFailure: (cause) => Option.getOrElse(Cause.findErrorOption(cause), () => String(cause)),
			});
			expect(msg instanceof Error ? msg.message : msg).toContain("body");
			expect(msg instanceof Error ? msg.message : msg).toContain("title-body");
		}),
	);

	it.effect("--template required when filling", () =>
		Effect.gen(function* () {
			const exit = yield* runCli([
				"--log-file",
				"/tmp/x",
				"--files-file",
				"/tmp/y",
				"--format",
				"body",
			]);
			expect(Exit.isFailure(exit)).toBe(true);
			const msg = Exit.match(exit, {
				onSuccess: () => "",
				onFailure: (cause) => Option.getOrElse(Cause.findErrorOption(cause), () => String(cause)),
			});
			expect(msg instanceof Error ? msg.message : msg).toContain("--template");
		}),
	);
});
