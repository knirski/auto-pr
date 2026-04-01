/**
 * Pure core for fill-pr-template. No Effect, no I/O.
 * Returns Result for parseCommits; all other functions return plain values.
 */

import type { Commit } from "conventional-commits-parser";
import { CommitParser } from "conventional-commits-parser";
import { Option, pipe, Result } from "effect";
import * as Arr from "effect/Array";
import { render } from "micromustache";
import { collapseProseParagraphs } from "#core/collapse-prose-paragraphs.js";
import { DescriptionParseError, ParseError, TemplateRenderError } from "#core/errors.js";
import { isBlank, isMergeCommitSubject, parseSubjects, toError } from "#core/string.js";

// ─── Types ─────────────────────────────────────────────────────────────────

/** Parsed commit info. */
export interface CommitInfo {
	readonly subject: string;
	readonly body: string;
	readonly fullMessage: string;
	readonly type: string | null;
	readonly references: readonly string[];
	readonly breakingNote: string | null;
}

/** Template substitution data. */
export interface TemplateData {
	readonly description: string;
	readonly typeOfChange: TypeOfChange;
	readonly changes: readonly string[];
	readonly commitsConventional: boolean;
	readonly docsUpdated: boolean;
	readonly testsAdded: boolean;
	readonly relatedIssues: readonly string[];
	readonly breakingChanges: string;
}

const TYPE_OF_CHANGE = [
	"Bug fix",
	"Security fix",
	"Breaking change",
	"Chore",
	"Documentation update",
	"New feature",
] as const;
export type TypeOfChange = (typeof TYPE_OF_CHANGE)[number];

const CONVENTIONAL_TYPES = [
	"feat",
	"fix",
	"docs",
	"security",
	"chore",
	"ci",
	"build",
	"refactor",
	"style",
	"test",
	"perf",
	"revert",
] as const;
type ConventionalType = (typeof CONVENTIONAL_TYPES)[number];

// ─── Constants ─────────────────────────────────────────────────────────────

const ISSUE_STARTS_PATTERN = /^(Closes|Fixes|Fix|Resolves|Resolve|Closed|Close) #\d+/i;

const TYPE_MAP: Record<ConventionalType, TypeOfChange> = {
	feat: "New feature",
	fix: "Bug fix",
	docs: "Documentation update",
	security: "Security fix",
	chore: "Chore",
	ci: "Chore",
	build: "Chore",
	refactor: "Chore",
	style: "Chore",
	test: "Chore",
	perf: "Chore",
	revert: "Chore",
};

const parser = new CommitParser();

// ─── Pure functions ────────────────────────────────────────────────────────

function isConventionalType(s: string): s is ConventionalType {
	return CONVENTIONAL_TYPES.some((t) => t === s);
}

function typeFromString(s: string | null | undefined): TypeOfChange {
	if (!s) return "Chore";
	const lower = s.toLowerCase();
	return isConventionalType(lower) ? TYPE_MAP[lower] : "Chore";
}

function mapParsedToCommitInfo(block: string, parsed: Commit): CommitInfo {
	const header = parsed.header ?? block.split("\n")[0] ?? "";
	const bodyParts = [parsed.body, parsed.footer].filter(Boolean);
	const body = bodyParts.join("\n\n").trim();
	const refs = parsed.references.map((r) => {
		const action = r.action ?? "Closes";
		const ref =
			r.owner != null && r.repository != null
				? `${r.owner}/${r.repository}#${r.issue}`
				: `${r.prefix ?? "#"}${r.issue}`;
		return `${action} ${ref}`;
	});
	const breaking = parsed.notes.find((n) => /BREAKING/i.test(n.title));
	return {
		subject: header,
		body,
		fullMessage: block,
		type: parsed.type ?? null,
		references: refs,
		breakingNote: breaking?.text ?? null,
	};
}

export function parseCommits(logOutput: string): Result.Result<readonly CommitInfo[], ParseError> {
	return Result.try({
		try: () => {
			const blocks = logOutput
				.split("---COMMIT---")
				.map((b) => b.trim())
				.filter(Boolean);
			return blocks.map((block) => mapParsedToCommitInfo(block, parser.parse(block)));
		},
		catch: (e) =>
			new ParseError({
				message: "Failed to parse commits",
				cause: toError(e),
			}),
	});
}

/**
 * Infer PR "Type of change" from commits and optionally the final PR title.
 * When `prTitle` is set (e.g. AI-generated title for multi-commit PRs), the title's
 * conventional type wins so the template matches `gh pr` title and body.
 */
export function inferTypeOfChange(commits: readonly CommitInfo[], prTitle?: string): TypeOfChange {
	const hasBreaking = commits.some((c) => c.breakingNote != null);
	if (hasBreaking) return "Breaking change";

	const titleTrim = prTitle?.trim();
	if (titleTrim && isBreakingConventionalTitle(titleTrim)) {
		return "Breaking change";
	}

	if (titleTrim && isValidConventionalTitle(titleTrim)) {
		const token = extractConventionalTypeFromTitle(titleTrim);
		if (token) {
			return typeFromString(token.toLowerCase());
		}
	}

	const first = commits[0];
	if (!first) return "Chore";
	const sub = first.subject;
	if (/^feat!|^feat\(.*\)!:|^BREAKING/.test(sub)) return "Breaking change";

	const fromType = typeFromString(first.type);
	if (fromType !== "Chore") return fromType;
	const prefix = sub.toLowerCase().split(":")[0] ?? "";
	return typeFromString(prefix);
}

function extractConventionalTypeFromTitle(title: string): string | null {
	const m = CONVENTIONAL_HEADER_PATTERN.exec(title.trim());
	return m?.[1] ?? null;
}

/** Header uses `!` before `:` (any type), or starts with BREAKING. */
function isBreakingConventionalTitle(title: string): boolean {
	const t = title.trim();
	if (/^BREAKING\b/i.test(t)) return true;
	return /^\w+(?:\([^)]*\))?!:/.test(t);
}

export function getTitle(commits: readonly CommitInfo[]): string {
	const first = commits[0];
	return first?.subject ?? "";
}

const CONVENTIONAL_HEADER_PATTERN = /^(\w+)(?:\([^)]*\))?!?: .+$/;

/** True when trimmed title matches `type(scope)?: subject` (72-char limit not applied). */
export function matchesConventionalTitleFormat(s: string): boolean {
	return CONVENTIONAL_HEADER_PATTERN.test(s.trim());
}

/** True when title is non-blank and trimmed length is at most 72 (Git subject-line convention). */
export function isWithinLengthLimit(s: string): boolean {
	return !isBlank(s) && s.trim().length <= 72;
}

export function isValidConventionalTitle(s: string): boolean {
	return isWithinLengthLimit(s) && matchesConventionalTitleFormat(s);
}

/**
 * Validate title and description for PR. Fails if title/description blank or title not conventional.
 * Used after AI provider returns structured output or after parsing raw response.
 */
export function validateTitleDescription(value: {
	title: string;
	description: string;
}): Result.Result<{ title: string; description: string }, DescriptionParseError> {
	const { title, description } = value;
	if (isBlank(title)) {
		return Result.fail(new DescriptionParseError({ cause: "title is empty" }));
	}
	if (isBlank(description)) {
		return Result.fail(new DescriptionParseError({ cause: "description is empty" }));
	}
	if (!isValidConventionalTitle(title)) {
		return Result.fail(
			new DescriptionParseError({
				cause: `title not conventional format: "${title}"`,
			}),
		);
	}
	return Result.succeed({ title, description });
}

export function getDescription(first: CommitInfo): string {
	const body = first.body.trim();
	const firstLine = body.split("\n")[0] ?? "";
	if (body && !ISSUE_STARTS_PATTERN.test(firstLine)) {
		const raw = body.split("\n").slice(0, 20).join("\n");
		return collapseProseParagraphs(raw);
	}
	const match = /^[^:]+:\s*(.+)$/.exec(first.subject);
	const captured = match?.[1];
	return captured != null ? captured.trim() : first.subject;
}

export function getDescriptionFromCommits(commits: readonly CommitInfo[]): string {
	const parts = commits.map((c) => getDescription(c)).filter((s) => !isBlank(s));
	return parts.join("\n\n");
}

export function getDescriptionPromptText(commits: readonly CommitInfo[]): string {
	return commits
		.map((c) => {
			const block = c.body.trim() ? `${c.subject}\n\n${c.body}` : c.subject;
			return `- ${block}`;
		})
		.join("\n\n");
}

export function getChanges(commits: readonly CommitInfo[]): readonly string[] {
	return commits.filter((c) => c.subject).map((c) => `- ${c.subject}`);
}

function isDocsFile(f: string): boolean {
	return f.endsWith(".md") || f.startsWith("docs/");
}

export function isDocsOnly(files: readonly string[]): boolean {
	return files.length === 0 || files.every(isDocsFile);
}

export function hasTestFiles(files: readonly string[]): boolean {
	return files.some(
		(f) =>
			f.endsWith(".test.ts") || f.endsWith(".spec.ts") || /\/test\//.test(f) || /\/spec\//.test(f),
	);
}

export function hasDocsFiles(files: readonly string[]): boolean {
	return files.some(isDocsFile);
}

export function isConventional(commit: CommitInfo): boolean {
	return commit.type != null;
}

export function isMergeCommit(c: CommitInfo): boolean {
	return isMergeCommitSubject(c.subject);
}

export function filterMergeCommits(commits: readonly CommitInfo[]): readonly CommitInfo[] {
	return commits.filter((c) => !isMergeCommit(c));
}

/** Parse newline-separated file paths from content. Uses parseSubjects from core. */
export function parseFilesContent(content: string): readonly string[] {
	return parseSubjects(content);
}

/** Check if body contains unreplaced {{placeholder}}s. */
export function hasUnreplacedPlaceholders(body: string): boolean {
	return body.includes("{{");
}

/** Format title and body as single string (title-body output format). */
export function formatTitleBody(title: string, body: string): string {
	return `${title}\n\n${body}`;
}

export function getRelatedIssues(commits: readonly CommitInfo[]): readonly string[] {
	return pipe(
		commits,
		(commits) => commits.flatMap((c) => c.references),
		(refs) => [...new Set(refs)].toSorted(),
	);
}

export function getBreakingChanges(commits: readonly CommitInfo[]): Option.Option<string> {
	return pipe(
		Arr.findFirst(
			commits,
			(c): c is CommitInfo & { breakingNote: string } => c.breakingNote != null,
		),
		Option.map((c) => c.breakingNote.trim().slice(0, 2000)),
	);
}

/** Builds substitution data from commits and files. Does not fail; rendering is separate (see {@link renderBody}). */
export function fillTemplate(
	commits: readonly CommitInfo[],
	files: readonly string[],
	descriptionOverride?: string,
	/** When set (e.g. AI PR title), drives `typeOfChange` so it matches the title. */
	prTitleForTypeOfChange?: string,
): TemplateData {
	const typeOfChange = inferTypeOfChange(commits, prTitleForTypeOfChange);
	const description =
		descriptionOverride !== undefined && descriptionOverride !== ""
			? descriptionOverride
			: getDescriptionFromCommits(commits);
	const changes = commits.length ? getChanges(commits) : ["- "];
	const breaking = pipe(
		getBreakingChanges(commits),
		Option.getOrElse(() => ""),
	);
	return {
		description,
		typeOfChange,
		changes,
		commitsConventional: commits.length > 0 && commits.every(isConventional),
		docsUpdated: hasDocsFiles(files),
		testsAdded: hasTestFiles(files),
		relatedIssues: getRelatedIssues(commits),
		breakingChanges: typeOfChange === "Breaking change" ? breaking : "",
	};
}

function buildSubstitutionScope(data: TemplateData): Record<string, string> {
	const conv = data.commitsConventional ? "x" : " ";
	const docs = data.docsUpdated ? "x" : " ";
	const tests = data.testsAdded ? "x" : " ";
	return {
		description: data.description,
		typeOfChange: data.typeOfChange,
		changes: data.changes.length ? data.changes.join("\n") : "- ",
		checklistConventional: conv,
		checklistDocs: docs,
		checklistTests: tests,
		relatedIssues: data.relatedIssues.length ? data.relatedIssues.join("\n") : "",
		breakingChanges: data.breakingChanges ?? "",
		placeholder: "placeholder",
	};
}

/**
 * Fill template from commits and files, then render with micromustache.
 * Can throw on malformed template syntax (e.g. `{{}}`, `{{a{{b}}`).
 */
export function renderBody(
	commits: readonly CommitInfo[],
	files: readonly string[],
	template: string,
	descriptionOverride?: string,
	prTitleForTypeOfChange?: string,
): Result.Result<string, TemplateRenderError> {
	const data = fillTemplate(commits, files, descriptionOverride, prTitleForTypeOfChange);
	return Result.try({
		try: () => render(template, buildSubstitutionScope(data)),
		catch: (e) =>
			new TemplateRenderError({
				message: "Failed to render template",
				cause: toError(e),
			}),
	});
}
