/**
 * Prompt building helpers. Pure, no I/O.
 */

/** Build full description prompt from template and commit content. */
export function buildDescriptionPrompt(promptTemplate: string, commitContent: string): string {
	return `${promptTemplate.trim()}\n\nCommits:\n${commitContent}`;
}
