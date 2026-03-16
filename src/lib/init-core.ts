/**
 * Pure core for init tool. No Effect, no I/O.
 */

export interface InitFileSpec {
	readonly dest: string;
	readonly from?: string;
	readonly content?: string;
}

/** File specs for init: dest (relative to cwd), optional from (package path), optional inline content. */
export function getInitFileSpecs(): readonly InitFileSpec[] {
	return [
		{
			dest: ".github/workflows/auto-pr.yml",
			from: ".github/workflows/auto-pr.yml",
		},
		{
			dest: ".github/PULL_REQUEST_TEMPLATE.md",
			from: ".github/PULL_REQUEST_TEMPLATE.md",
		},
		{ dest: ".nvmrc", content: "24\n" },
	];
}
