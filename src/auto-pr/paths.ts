/**
 * Path resolution for package-relative assets. Uses Effect Path service.
 */

import { Effect, Path } from "effect";

/** Resolve path to pr-description.txt prompt (package-relative). Uses Path service. */
export const getPrDescriptionPromptPath = Effect.fn("getPrDescriptionPromptPath")(function* () {
	const pathApi = yield* Path.Path;
	const scriptPath = yield* pathApi.fromFileUrl(new URL(import.meta.url));
	return pathApi.join(pathApi.dirname(scriptPath), "prompts", "pr-description.txt");
});
