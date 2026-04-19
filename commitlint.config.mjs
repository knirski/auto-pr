export default {
	extends: ['@commitlint/config-conventional'],
	// Dependabot uses sentence-case subjects ("Bump …") and long table/URL lines that
	// violate subject-case and body-max-line-length; still enforce rules for human commits.
	ignores: [(message) => /Signed-off-by:\s*dependabot\[bot\]/i.test(message)],
};
