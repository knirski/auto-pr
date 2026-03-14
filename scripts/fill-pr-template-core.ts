/**
 * Pure core for fill-pr-template. No Effect, no I/O.
 * Returns Result for parseCommits; all other functions return plain values.
 */

import type { Commit } from "conventional-commits-parser";
import { CommitParser } from "conventional-commits-parser";
import { Option, pipe, Result } from "effect";
import * as Arr from "effect/Array";
import { ParseError } from "./auto-pr/errors.js";
import { collapseProseParagraphs } from "./collapse-prose-paragraphs.js";

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
	readonly howToTest: string;
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

const PLACEHOLDERS = [
	"description",
	"typeOfChange",
	"changes",
	"howToTest",
	"checklistConventional",
	"checklistDocs",
	"checklistTests",
	"relatedIssues",
	"breakingChanges",
	"placeholder",
] as const;
type Placeholder = (typeof PLACEHOLDERS)[number];

type SubstitutionMap = Record<Placeholder, string>;

const ESCAPE_OPEN = "\uE000";
const ESCAPE_CLOSE = "\uE001";

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
				cause: e instanceof Error ? e : new Error(String(e)),
			}),
	});
}

export function inferTypeOfChange(commits: readonly CommitInfo[]): TypeOfChange {
	const hasBreaking = commits.some((c) => c.breakingNote != null);
	if (hasBreaking) return "Breaking change";
	const first = commits[0];
	if (!first) return "Chore";
	const sub = first.subject;
	if (/^feat!|^feat\(.*\)!:|^BREAKING/.test(sub)) return "Breaking change";

	const fromType = typeFromString(first.type);
	if (fromType !== "Chore") return fromType;
	const prefix = sub.toLowerCase().split(":")[0] ?? "";
	return typeFromString(prefix);
}

export function getTitle(commits: readonly CommitInfo[]): string {
	const first = commits[0];
	return first?.subject ?? "";
}

const CONVENTIONAL_HEADER_PATTERN = /^(\w+)(?:\([^)]*\))?!?: .+$/;

export function isValidConventionalTitle(s: string): boolean {
	const trimmed = s.trim();
	if (trimmed.length === 0 || trimmed.length > 72) return false;
	return CONVENTIONAL_HEADER_PATTERN.test(trimmed);
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
	const parts = commits.map((c) => getDescription(c)).filter(Boolean);
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

export function isDocsOnly(files: readonly string[]): boolean {
	if (files.length === 0) return true;
	return files.every((f) => f.endsWith(".md") || f.startsWith("docs/"));
}

export function hasTestFiles(files: readonly string[]): boolean {
	return files.some(
		(f) =>
			f.endsWith(".test.ts") || f.endsWith(".spec.ts") || /\/test\//.test(f) || /\/spec\//.test(f),
	);
}

export function hasDocsFiles(files: readonly string[]): boolean {
	return files.some((f) => f.endsWith(".md") || f.startsWith("docs/"));
}

export function isConventional(commit: CommitInfo): boolean {
	return commit.type != null;
}

export function isMergeCommit(c: CommitInfo): boolean {
	return /^Merge /i.test(c.subject.trim());
}

export function filterMergeCommits(commits: readonly CommitInfo[]): readonly CommitInfo[] {
	return commits.filter((c) => !isMergeCommit(c));
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

const DEFAULT_HOW_TO_TEST = "1. Run `npm run check`\n2. ";

export function fillTemplate(
	commits: readonly CommitInfo[],
	files: readonly string[],
	descriptionOverride?: string,
	howToTestDefault?: string,
): TemplateData {
	const typeOfChange = inferTypeOfChange(commits);
	const description =
		descriptionOverride !== undefined && descriptionOverride !== ""
			? descriptionOverride
			: getDescriptionFromCommits(commits);
	const changes = commits.length ? getChanges(commits) : ["- "];
	const howToTest = isDocsOnly(files)
		? "N/A"
		: howToTestDefault !== undefined && howToTestDefault !== ""
			? howToTestDefault
			: DEFAULT_HOW_TO_TEST;
	const breaking = pipe(
		getBreakingChanges(commits),
		Option.getOrElse(() => ""),
	);

	return {
		description,
		typeOfChange,
		changes,
		howToTest,
		commitsConventional: commits.length > 0 && commits.every(isConventional),
		docsUpdated: hasDocsFiles(files),
		testsAdded: hasTestFiles(files),
		relatedIssues: getRelatedIssues(commits),
		breakingChanges: typeOfChange === "Breaking change" ? breaking : "",
	};
}

function buildSubstitutionMap(data: TemplateData): SubstitutionMap {
	const conv = data.commitsConventional ? "x" : " ";
	const docs = data.docsUpdated ? "x" : " ";
	const tests = data.testsAdded ? "x" : " ";
	return {
		description: data.description,
		typeOfChange: data.typeOfChange,
		changes: data.changes.length ? data.changes.join("\n") : "- ",
		howToTest: data.howToTest,
		checklistConventional: conv,
		checklistDocs: docs,
		checklistTests: tests,
		relatedIssues: data.relatedIssues.length ? data.relatedIssues.join("\n") : "",
		breakingChanges: data.breakingChanges || "",
		placeholder: "placeholder",
	};
}

function escapeForSubstitution(s: string): string {
	return s.replaceAll("{{", ESCAPE_OPEN).replaceAll("}}", ESCAPE_CLOSE);
}

function unescapeAfterSubstitution(s: string): string {
	return s.replaceAll(ESCAPE_OPEN, "{{").replaceAll(ESCAPE_CLOSE, "}}");
}

export function renderFromTemplate(template: string, data: TemplateData): string {
	const map = buildSubstitutionMap(data);
	const substituted = PLACEHOLDERS.reduce((out, key) => {
		const value = map[key];
		const escaped = escapeForSubstitution(value);
		return out.replaceAll(`{{${key}}}`, escaped);
	}, template);
	return unescapeAfterSubstitution(substituted);
}

/** Pure: fill template + substitute. Returns body string. */
export function renderBody(
	commits: readonly CommitInfo[],
	files: readonly string[],
	template: string,
	descriptionOverride?: string,
	howToTestDefault?: string,
): string {
	const data = fillTemplate(commits, files, descriptionOverride, howToTestDefault);
	return renderFromTemplate(template, data);
}
