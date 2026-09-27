export default {
	extends: ['@commitlint/config-conventional'],
	// Dependabot uses sentence-case subjects ("Bump …") and long table/URL lines that
	// violate subject-case and body-max-line-length; still enforce rules for human commits.
	// Release-please squash merges (especially via the GitHub UI) use the generated PR
	// body as the commit body, whose tables and links exceed body-max-line-length.
	ignores: [
		(message) => /Signed-off-by:\s*dependabot\[bot\]/i.test(message),
		(message) => /^chore\(main\): release /m.test(message),
	],
};
