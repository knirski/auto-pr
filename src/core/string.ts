/**
 * Pure string helpers. No Effect, no I/O.
 */

/** Check if string is empty or whitespace-only. */
export function isBlank(s: string): boolean {
	return s.trim().length === 0;
}

/** Merge commits (e.g. "Merge branch 'x' into y") add no semantic value. */
export function isMergeCommitSubject(subject: string): boolean {
	return /^Merge /i.test(subject.trim());
}

/** Parse newline-separated subjects from file content. */
export function parseSubjects(content: string): string[] {
	return content
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Convert unknown to a short message for display. */
export function unknownToMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Ensure unknown is an Error (pass through or wrap). Use for cause fields. */
export function toError(e: unknown): Error {
	return e instanceof Error ? e : new Error(String(e));
}

/** Filter out merge commits and blank lines from subject list. */
export function filterSemanticSubjects(subjects: string[]): string[] {
	return subjects
		.map((s) => s.trim())
		.filter((line) => !isBlank(line) && !isMergeCommitSubject(line));
}

/** Check if HTTP status indicates error (4xx or 5xx). */
export function isHttpError(status: number): boolean {
	return status >= 400;
}

/**
 * Truncate a string for log output. Returns the trimmed string if within limit,
 * otherwise truncates and appends an indicator with the full length.
 */
export function truncateForLog(s: string, maxChars: number): string {
	const t = s.trim();
	if (t.length <= maxChars) {
		return t;
	}
	return `${t.slice(0, maxChars)}… (${t.length} chars total)`;
}
