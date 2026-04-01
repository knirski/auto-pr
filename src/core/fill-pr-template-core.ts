/**
 * Pure core for fill-pr-template. No Effect, no I/O.
 * Returns Result for parseCommits; all other functions return plain values.
 */

import type { Commit } from "conventional-commits-parser";
import { CommitParser } from "conventional-commits-parser";
import { Option, pipe, Result } from "effect";
import { render } from "micromustache";
import { collapseProseParagraphs } from "#core/collapse-prose-paragraphs.js";
import { DescriptionParseError, ParseError, TemplateRenderError } from "#core/errors.js";
import { PR_TITLE_LINE_MAX_LENGTH } from "#core/pr-title-line-max-length.js";
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

/** GitHub issue/PR numbers are numeric; ignore `#word` prose (e.g. TS path `#core`). */
function isNumericGitHubIssueId(issue: string): boolean {
	return /^\d+$/.test(issue);
}

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
	const refs = parsed.references
		.filter((r) => isNumericGitHubIssueId(r.issue))
		.map((r) => {
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

	if (titleTrim && matchesConventionalTitleFormat(titleTrim)) {
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
export function isBreakingConventionalTitle(title: string): boolean {
	const t = title.trim();
	if (/^BREAKING\b/i.test(t)) return true;
	return /^\w+(?:\([^)]*\))?!:/.test(t);
}

export function getTitle(commits: readonly CommitInfo[]): string {
	const first = commits[0];
	return first?.subject ?? "";
}

const CONVENTIONAL_HEADER_PATTERN = /^(\w+)(?:\([^)]*\))?!?: .+$/;

/** Capture prefix (through `": `") and subject for shortening long conventional titles. */
const CONVENTIONAL_PREFIX_AND_SUBJECT_PATTERN = /^(\w+(?:\([^)]*\))?!?: )(.+)$/;

/** True when trimmed title matches `type(scope)?: subject` (line length limit not applied). */
export function matchesConventionalTitleFormat(s: string): boolean {
	return CONVENTIONAL_HEADER_PATTERN.test(s.trim());
}

/** True when title is non-blank and trimmed length is at most {@link PR_TITLE_LINE_MAX_LENGTH}. */
export function isWithinLengthLimit(s: string): boolean {
	return !isBlank(s) && s.trim().length <= PR_TITLE_LINE_MAX_LENGTH;
}

export function isValidConventionalTitle(s: string): boolean {
	return isWithinLengthLimit(s) && matchesConventionalTitleFormat(s);
}

/**
 * If the title matches conventional format but exceeds {@link PR_TITLE_LINE_MAX_LENGTH},
 * shorten the subject so the full line fits. Fails if the header alone does not leave room
 * for a non-empty subject.
 */
export function fitConventionalTitleToLengthLimit(
	s: string,
): Result.Result<string, DescriptionParseError> {
	const t = s.trim();
	if (isBlank(t)) {
		return Result.fail(new DescriptionParseError({ cause: "title is empty" }));
	}
	if (!matchesConventionalTitleFormat(t)) {
		return Result.fail(
			new DescriptionParseError({ cause: `title not conventional format: "${t}"` }),
		);
	}
	if (isWithinLengthLimit(t)) {
		return Result.succeed(t);
	}
	const m = CONVENTIONAL_PREFIX_AND_SUBJECT_PATTERN.exec(t);
	if (m === null) {
		return Result.fail(
			new DescriptionParseError({ cause: `title not conventional format: "${t}"` }),
		);
	}
	const prefix = m[1];
	const subject = m[2];
	if (prefix === undefined || subject === undefined) {
		return Result.fail(
			new DescriptionParseError({ cause: `title not conventional format: "${t}"` }),
		);
	}
	const maxSubjectLen = PR_TITLE_LINE_MAX_LENGTH - prefix.length;
	if (maxSubjectLen < 1) {
		return Result.fail(
			new DescriptionParseError({
				cause: `title exceeds ${PR_TITLE_LINE_MAX_LENGTH} characters and cannot be shortened (header too long): "${t}"`,
			}),
		);
	}
	const shortenedSubject = subject.slice(0, maxSubjectLen).trimEnd();
	if (isBlank(shortenedSubject)) {
		return Result.fail(
			new DescriptionParseError({
				cause: `title exceeds ${PR_TITLE_LINE_MAX_LENGTH} characters and no usable subject remains after shortening: "${t}"`,
			}),
		);
	}
	const out = `${prefix}${shortenedSubject}`;
	if (!isValidConventionalTitle(out)) {
		return Result.fail(
			new DescriptionParseError({
				cause: `title could not be shortened to a valid conventional line: "${t}"`,
			}),
		);
	}
	return Result.succeed(out);
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
	if (isBlank(description)) {
		return Result.fail(new DescriptionParseError({ cause: "description is empty" }));
	}
	return pipe(
		fitConventionalTitleToLengthLimit(title),
		Result.flatMap((fitted) => Result.succeed({ title: fitted, description })),
	);
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

/** Max length for `{{breakingChanges}}` body. */
export const BREAKING_CHANGES_BODY_MAX_LENGTH = 2000;

/** All `BREAKING CHANGE:` footer texts in commit order, joined with blank lines. */
export function getBreakingChanges(commits: readonly CommitInfo[]): Option.Option<string> {
	const texts = commits
		.map((c) => c.breakingNote)
		.filter((n): n is string => n != null && n.trim() !== "")
		.map((n) => n.trim());
	if (texts.length === 0) return Option.none();
	return Option.some(texts.join("\n\n").slice(0, BREAKING_CHANGES_BODY_MAX_LENGTH));
}

/**
 * Subject or PR title line: description after `type!:` / `type(scope)!:`; otherwise full line when it starts with `BREAKING`.
 */
export function extractBreakingDescriptionFromLine(line: string): Option.Option<string> {
	const t = line.trim();
	if (t === "") return Option.none();
	if (/^BREAKING\b/i.test(t)) {
		return Option.some(t);
	}
	const m = /^\w+(?:\([^)]*\))?!: (.+)$/.exec(t);
	return m?.[1] != null && m[1].trim() !== "" ? Option.some(m[1].trim()) : Option.none();
}

/**
 * Text for `{{breakingChanges}}`: footers first (all commits, in order), else synthetic text from a breaking PR title, else from commit subjects (`feat!:`, etc.).
 */
export function resolveBreakingChangesBody(
	commits: readonly CommitInfo[],
	prTitleForTypeOfChange?: string,
): string {
	return pipe(
		getBreakingChanges(commits),
		Option.match({
			onNone: () => resolveSyntheticBreakingDescription(commits, prTitleForTypeOfChange),
			onSome: (s) => s,
		}),
	);
}

function resolveSyntheticBreakingDescription(
	commits: readonly CommitInfo[],
	prTitle?: string,
): string {
	const titleTrim = prTitle?.trim();
	if (titleTrim && isBreakingConventionalTitle(titleTrim)) {
		return pipe(
			extractBreakingDescriptionFromLine(titleTrim),
			Option.getOrElse(() => titleTrim),
		).slice(0, BREAKING_CHANGES_BODY_MAX_LENGTH);
	}
	const parts: string[] = [];
	for (const c of commits) {
		pipe(
			extractBreakingDescriptionFromLine(c.subject),
			Option.match({
				onNone: () => {},
				onSome: (s) => {
					parts.push(s);
				},
			}),
		);
	}
	return parts.join("\n\n").slice(0, BREAKING_CHANGES_BODY_MAX_LENGTH);
}

/** Builds substitution data from commits and files. Does not fail; rendering is separate (see {@link renderBody}). */
export function fillTemplate(
	commits: readonly CommitInfo[],
	files: readonly string[],
	descriptionOverride?: string,
	/** When set (e.g. AI PR title), drives `typeOfChange` and breaking summary when the title uses `!:` / `BREAKING`. */
	prTitleForTypeOfChange?: string,
): TemplateData {
	const typeOfChange = inferTypeOfChange(commits, prTitleForTypeOfChange);
	const description =
		descriptionOverride !== undefined && descriptionOverride !== ""
			? descriptionOverride
			: getDescriptionFromCommits(commits);
	const changes = commits.length ? getChanges(commits) : ["- "];
	const breakingChanges =
		typeOfChange === "Breaking change"
			? resolveBreakingChangesBody(commits, prTitleForTypeOfChange)
			: "";
	return {
		description,
		typeOfChange,
		changes,
		commitsConventional: commits.length > 0 && commits.every(isConventional),
		docsUpdated: hasDocsFiles(files),
		testsAdded: hasTestFiles(files),
		relatedIssues: getRelatedIssues(commits),
		breakingChanges,
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
