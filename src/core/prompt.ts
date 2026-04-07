/**
 * Prompt building helpers. Pure, no I/O.
 */

/** Build full description prompt from template, optional diffstat, and commit content. */
export function buildDescriptionPrompt(
	promptTemplate: string,
	diffStat: string,
	commitContent: string,
): string {
	const sections = [promptTemplate.trim()];
	if (diffStat?.trim()) {
		sections.push(`Changed files (diff stat):\n${diffStat.trim()}`);
	}
	sections.push(`Commits:\n${commitContent}`);
	return sections.join("\n\n");
}
