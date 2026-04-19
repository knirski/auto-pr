/**
 * Prompt building helpers. Pure, no I/O.
 */

/** Build full description prompt from template, optional diffstat, commit content, and optional existing PR title. */
export function buildDescriptionPrompt(
	promptTemplate: string,
	diffStat: string,
	commitContent: string,
	existingPrTitle?: string,
): string {
	const sections = [promptTemplate.trim()];
	if (diffStat?.trim()) {
		sections.push(`Changed files (diff stat):\n${diffStat.trim()}`);
	}
	sections.push(`Commits:\n${commitContent}`);
	const prior = existingPrTitle?.trim();
	if (prior) {
		sections.push(
			`Existing PR title (open PR for this branch; prefer keeping it if it still matches the commits above—change only if commits clearly shift scope, fix a wrong type prefix, or make the old title misleading):\n${prior}`,
		);
	}
	return sections.join("\n\n");
}
