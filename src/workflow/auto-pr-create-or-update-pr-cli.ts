/**
 * CLI entry point for auto-pr-create-or-update-pr. Kept separate from
 * `auto-pr-create-or-update-pr.ts` (the library module) so that bundling
 * `auto-pr-create-or-update-pr.ts` into another entrypoint (e.g. `auto-pr-run.ts`, via
 * `auto-pr-run-pipeline.ts`) never inlines this file's `runMain` call alongside it.
 *
 * This repo: bun run create-or-update-pr · installed: npx auto-pr-create-or-update-pr
 */

import { runMain } from "#auto-pr";
import { program } from "#workflow/auto-pr-create-or-update-pr.js";

runMain(program, "create_or_update_pr_failed");
