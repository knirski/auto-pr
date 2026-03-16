import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { getPrDescriptionPromptPath } from "#auto-pr";
import { TestBaseLayer } from "#test/test-utils.js";

layer(TestBaseLayer)("getPrDescriptionPromptPath", (it) => {
	it.effect("returns path ending with prompts/pr-description.txt", () =>
		Effect.gen(function* () {
			const path = yield* getPrDescriptionPromptPath();
			expect(path).toMatch(/prompts[/\\]pr-description\.txt$/);
		}),
	);
});
