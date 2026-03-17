import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { getPrDescriptionPromptPath } from "#auto-pr";
import { runEffect } from "#test/run-effect.js";
import { TestBaseLayer } from "#test/test-utils.js";

describe("getPrDescriptionPromptPath", () => {
	test("returns path ending with prompts/pr-description.txt", async () => {
		await runEffect(
			Effect.gen(function* () {
				const path = yield* getPrDescriptionPromptPath();
				expect(path).toMatch(/prompts[/\\]pr-description\.txt$/);
			}),
			TestBaseLayer,
		);
	});
});
