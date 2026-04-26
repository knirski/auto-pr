import { describe, expect, test } from "bun:test";

import { rewriteLinks } from "../../website/scripts/copy-docs-core.js";

describe("website copy-docs link rewriting", () => {
	test("rewrites published top-level docs to site routes", () => {
		const input = "See [CI](CI.md#workflow-pin-automation).";

		expect(rewriteLinks(input, "docs")).toBe("See [CI](/auto-pr/ci/#workflow-pin-automation).");
	});

	test("rewrites published ADRs to site routes", () => {
		const input = "See [ADR](0007-ai-abstraction-layer.md).";

		expect(rewriteLinks(input, "docs/adr")).toBe(
			"See [ADR](/auto-pr/adr/0007-ai-abstraction-layer/).",
		);
	});

	test("rewrites repository-only markdown links to GitHub source", () => {
		const input =
			"See [supporting research](supporting/nix-ci-research.md) and [contributing](../../CONTRIBUTING.md).";

		expect(rewriteLinks(input, "docs/adr")).toBe(
			"See [supporting research](https://github.com/knirski/auto-pr/blob/main/docs/adr/supporting/nix-ci-research.md) and [contributing](https://github.com/knirski/auto-pr/blob/main/CONTRIBUTING.md).",
		);
	});

	test("rewrites workflow and action links to GitHub source", () => {
		const input =
			"Copy [workflow](../.github/workflows/auto-pr.yml) or read [setup-runtime](../.github/actions/setup-runtime/README.md).";

		expect(rewriteLinks(input, "docs")).toBe(
			"Copy [workflow](https://github.com/knirski/auto-pr/blob/main/.github/workflows/auto-pr.yml) or read [setup-runtime](https://github.com/knirski/auto-pr/blob/main/.github/actions/setup-runtime/README.md).",
		);
	});

	test("leaves external and anchor links unchanged", () => {
		const input = "See [GitHub](https://github.com/knirski/auto-pr) and [section](#setup).";

		expect(rewriteLinks(input, "docs")).toBe(input);
	});
});
