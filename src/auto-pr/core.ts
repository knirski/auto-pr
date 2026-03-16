/**
 * Pure core for auto-PR scripts. No Effect, no I/O.
 */

import { pipe, Result, Schema } from "effect";
import { OllamaDescriptionInvalidError } from "#auto-pr/errors.js";

/** Branded type for sanitized GITHUB_OUTPUT values (max 72 chars, percent/CR/newline escaped). */
const GhOutputValueSchema = Schema.String.pipe(
	Schema.check(Schema.isMaxLength(72)),
	Schema.brand("GhOutputValue"),
);
export type GhOutputValue = Schema.Schema.Type<typeof GhOutputValueSchema>;

/** Merge commits (e.g. "Merge branch 'x' into y") add no semantic value. */
export function isMergeCommitSubject(subject: string): boolean {
	return /^Merge /i.test(subject.trim());
}

/** Filter out merge commits and blank lines from subject list. */
export function filterSemanticSubjects(subjects: string[]): string[] {
	return subjects
		.map((s) => s.trim())
		.filter((line) => !isBlank(line) && !isMergeCommitSubject(line));
}

/** Format GITHUB_OUTPUT entries as key=value lines. */
export function formatGhOutput(
	entries: ReadonlyArray<{ key: string; value: string | GhOutputValue }>,
): string {
	return `${entries.map((e) => `${e.key}=${e.value}`).join("\n")}\n`;
}

/**
 * Escape value for GITHUB_OUTPUT format. Percent-encodes `%` → `%25`, `\n` → `%0A`, `\r` → `%0D`.
 * Trims and slices to 72 chars before escaping; escaping can lengthen the string (e.g. `%` → `%25`),
 * so validation may fail if the escaped result exceeds 72 chars.
 * Use {@link decodeGhOutputTitle} when reading the title back from parsed GITHUB_OUTPUT.
 */
export function sanitizeForGhOutput(s: string): Result.Result<GhOutputValue, Error> {
	const trimmed = s.trim().slice(0, 72);
	const escaped = trimmed.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
	return Result.try({
		try: () => Schema.decodeSync(GhOutputValueSchema)(escaped),
		catch: (e) =>
			new Error(
				`GITHUB_OUTPUT value exceeds 72 chars after escaping: ${e instanceof Error ? e.message : String(e)}`,
			),
	});
}

/** Check if string is empty or whitespace-only. */
export function isBlank(s: string): boolean {
	return s.trim().length === 0;
}

/** Check if HTTP status indicates error (4xx or 5xx). */
export function isHttpError(status: number): boolean {
	return status >= 400;
}

/** Parse newline-separated subjects from file content. */
export function parseSubjects(content: string): string[] {
	return content
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Trim quotes and surrounding whitespace from Ollama response. */
export function trimOllamaResponse(s: string): string {
	return s.replace(/^"|"$/g, "").replace(/^\s+|\s+$/g, "");
}

/** Build full description prompt from template and commit content. */
export function buildDescriptionPrompt(promptTemplate: string, commitContent: string): string {
	return `${promptTemplate.trim()}\n\nCommits:\n${commitContent}`;
}

/** Validate description response: non-empty, not "null". */
export function validateDescriptionResponse(
	raw: string,
): Result.Result<string, OllamaDescriptionInvalidError> {
	const t = trimOllamaResponse(raw);
	if (!t || t === "null") return Result.fail(new OllamaDescriptionInvalidError({ cause: "empty" }));
	return Result.succeed(t);
}

/** Parse Ollama response: line 1 = title, line 2 = blank, line 3+ = description. */
export function parseTitleDescriptionResponse(
	raw: string,
): Result.Result<{ title: string; description: string }, OllamaDescriptionInvalidError> {
	const t = trimOllamaResponse(raw);
	if (!t || t === "null") return Result.fail(new OllamaDescriptionInvalidError({ cause: "empty" }));
	const lines = t.split("\n");
	const title = lines[0]?.trim();
	const description = lines.slice(2).join("\n").trim();
	if (!title || !description) {
		return Result.fail(
			new OllamaDescriptionInvalidError({
				cause:
					"title or description missing (expected: line 1 = title, line 2 = blank, line 3+ = description)",
			}),
		);
	}
	return Result.succeed({ title, description });
}

// ─── GITHUB_OUTPUT parsing (run-auto-pr) ──────────────────────────────────────

/** Parse key=value lines from GITHUB_OUTPUT content into a record. */
export function parseGhOutput(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of content.split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) {
			const key = line.slice(0, eq);
			const value = line.slice(eq + 1);
			result[key] = value;
		}
	}
	return result;
}

/** Get value from parsed GITHUB_OUTPUT. Fails when key is absent. */
export function getGhOutputValue(
	parsed: Record<string, string>,
	key: string,
): Result.Result<string, Error> {
	const value = parsed[key];
	if (value === undefined) {
		return Result.fail(new Error(`GITHUB_OUTPUT missing key: ${key}`));
	}
	return Result.succeed(value);
}

/**
 * Decode percent-encoded title from GITHUB_OUTPUT.
 *
 * When writing to GITHUB_OUTPUT, {@link sanitizeForGhOutput} encodes `%` → `%25`, `\n` → `%0A`, `\r` → `%0D`.
 * When reading the file (e.g. in run-auto-pr), we get the raw encoded string. This reverses that encoding
 * so the title can be passed to `gh pr create` / `gh pr edit`.
 * Fails when raw is absent (undefined or blank).
 */
export function decodeGhOutputTitle(raw: string): Result.Result<string, Error> {
	if (raw.trim() === "") {
		return Result.fail(new Error("GITHUB_OUTPUT title is absent"));
	}
	try {
		return Result.succeed(decodeURIComponent(raw));
	} catch (e) {
		return Result.fail(
			new Error(
				`Failed to decode GITHUB_OUTPUT title: ${e instanceof Error ? e.message : String(e)}`,
			),
		);
	}
}

/** Validate get-commits GITHUB_OUTPUT. Returns Result with commits and files paths. */
export function validateGetCommitsOutput(
	parsed: Record<string, string>,
): Result.Result<{ commits: string; files: string }, Error> {
	return pipe(
		getGhOutputValue(parsed, "commits"),
		Result.flatMap((commits) =>
			pipe(
				getGhOutputValue(parsed, "files"),
				Result.flatMap((files) =>
					isBlank(commits) || isBlank(files)
						? Result.fail(new Error("Get commits did not output commits and files"))
						: Result.succeed({ commits, files }),
				),
			),
		),
	);
}

/** Validate generate-content GITHUB_OUTPUT. Returns Result with title and body_file. */
export function validateGenerateContentOutput(
	parsed: Record<string, string>,
): Result.Result<{ title: string; bodyFile: string }, Error> {
	return pipe(
		getGhOutputValue(parsed, "title"),
		Result.flatMap((titleRaw) =>
			pipe(
				getGhOutputValue(parsed, "body_file"),
				Result.flatMap((bodyFile) =>
					isBlank(bodyFile)
						? Result.fail(new Error("Generate content did not output title and body_file"))
						: pipe(
								decodeGhOutputTitle(titleRaw),
								Result.flatMap((title) =>
									isBlank(title)
										? Result.fail(new Error("Generate content did not output title and body_file"))
										: Result.succeed({ title, bodyFile }),
								),
							),
				),
			),
		),
	);
}

// ─── GITHUB_OUTPUT entry builders ─────────────────────────────────────────────

/** Build GITHUB_OUTPUT entries for get-commits step. */
export function buildGetCommitsGhEntries(
	commitsPath: string,
	filesPath: string,
	semanticCount: number,
): ReadonlyArray<{ key: string; value: string }> {
	return [
		{ key: "commits", value: commitsPath },
		{ key: "files", value: filesPath },
		{ key: "count", value: String(semanticCount) },
	];
}

/** Build GITHUB_OUTPUT entries for generate-content step. */
export function buildGenerateContentGhEntries(
	title: string,
	bodyPath: string,
): Result.Result<ReadonlyArray<{ key: string; value: string | GhOutputValue }>, Error> {
	return pipe(
		sanitizeForGhOutput(title),
		Result.map(
			(sanitized) =>
				[
					{ key: "title", value: sanitized },
					{ key: "body_file", value: bodyPath },
				] as const,
		),
	);
}
