/**
 * Resolve package-relative paths. Uses import.meta.url for ESM.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to pr-description.txt prompt (package-relative). */
export const PR_DESCRIPTION_PROMPT_PATH = join(__dirname, "prompts", "pr-description.txt");
