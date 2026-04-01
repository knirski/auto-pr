/**
 * Single cap for PR title lines: conventional validation, AI truncation, and `GITHUB_OUTPUT`
 * sanitization. Kept below GitHub’s API title limit; wider than classic 72-char commit subjects.
 */
export const PR_TITLE_LINE_MAX_LENGTH = 100 as const;
