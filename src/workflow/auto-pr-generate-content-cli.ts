/**
 * CLI entry point for auto-pr-generate-content. Kept separate from
 * `auto-pr-generate-content.ts` (the library module) so that bundling `auto-pr-generate-content.ts`
 * into another entrypoint (e.g. `auto-pr-run.ts`, via `auto-pr-run-pipeline.ts`) never inlines
 * this file's `runMain` call alongside it.
 *
 * This repo: bun run generate-content · installed: npx auto-pr-generate-content
 */

import { runMain } from "#auto-pr";
import { program } from "#workflow/auto-pr-generate-content.js";

runMain(program, "generate_pr_content_failed");
