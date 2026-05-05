/**
 * Prompt building helpers. Pure, no I/O.
 */

/** Build full description prompt from template, commit content, optional diffstat, routing context, and optional existing PR title. */
export function buildDescriptionPrompt(
  promptTemplate: string,
  commitContent: string,
  diffStat?: string,
  existingPrTitle?: string,
  routingContext?: string,
): string {
  const sections = [promptTemplate.trim()];
  sections.push(`Commits:\n${commitContent}`);
  if (diffStat?.trim()) {
    sections.push(`Changed files (diff stat):\n${diffStat.trim()}`);
  }
  if (routingContext?.trim()) {
    sections.push(`Routing context:\n${routingContext.trim()}`);
  }
  const prior = existingPrTitle?.trim();
  if (prior) {
    sections.push(
      `Existing PR title (open PR for this branch; prefer keeping it if it still matches the commits above—change only if commits clearly shift scope, fix a wrong type prefix, or make the old title misleading):\n${prior}`,
    );
  }
  return sections.join("\n\n");
}
