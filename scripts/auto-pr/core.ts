/**
 * Pure core for auto-PR scripts. No Effect, no I/O.
 */

import { Result } from "effect";
import { OllamaDescriptionInvalid } from "./errors.js";

/** Merge commits (e.g. "Merge branch 'x' into y") add no semantic value. */
export function isMergeCommitSubject(subject: string): boolean {
	return /^Merge /i.test(subject.trim());
}

/** Filter out merge commits and blank lines from subject list. */
export function filterSemanticSubjects(subjects: string[]): string[] {
	return subjects
		.map((s) => s.trim())
		.filter((line) => line.length > 0 && !isMergeCommitSubject(line));
}

/** Format GITHUB_OUTPUT entries as key=value lines. */
export function formatGhOutput(entries: ReadonlyArray<{ key: string; value: string }>): string {
	return `${entries.map((e) => `${e.key}=${e.value}`).join("\n")}\n`;
}

/** Escape value for GitHub Actions output (multiline, percent, CR). */
export function sanitizeForGhOutput(s: string): string {
	const trimmed = s.trim().slice(0, 72);
	return trimmed.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Check if string is empty or whitespace-only. */
export function isBlank(s: string): boolean {
	return s.trim().length === 0;
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
): Result.Result<string, OllamaDescriptionInvalid> {
	const t = trimOllamaResponse(raw);
	if (!t || t === "null") return Result.fail(new OllamaDescriptionInvalid({ cause: "empty" }));
	return Result.succeed(t);
}
