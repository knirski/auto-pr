/**
 * Path resolution for package-relative assets. Uses Effect Path service.
 */

import { Effect, Path } from "effect";

/** Written by generate-content under `GITHUB_WORKSPACE`; read by create-or-update-pr. */
export const PR_TITLE_FILE_NAME = "pr-title.txt";

/** Written by generate-content under `GITHUB_WORKSPACE`; read by create-or-update-pr. */
export const PR_BODY_FILE_NAME = "pr-body.md";

/** Resolve path to pr-description.txt prompt (package-relative). Uses Path service. */
export const getPrDescriptionPromptPath = Effect.fn("getPrDescriptionPromptPath")(function* () {
  const pathApi = yield* Path.Path;
  const scriptPath = yield* pathApi.fromFileUrl(new URL(import.meta.url));
  return pathApi.join(pathApi.dirname(scriptPath), "prompts", "pr-description.txt");
});
