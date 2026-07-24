/**
 * Regression test for cross-entrypoint contamination in the built `dist/` bin scripts.
 *
 * `auto-pr-run.ts` imports `auto-pr-run-pipeline.ts`, which in turn imports
 * `auto-pr-generate-content.ts` and `auto-pr-create-or-update-pr.ts` (for their library exports
 * only). When Bun bundles `auto-pr-run.ts` as a standalone entrypoint, it inlines the entire
 * module bodies of everything it transitively imports. If any of those modules also carried
 * their own `if (import.meta.main) { runMain(...) }` CLI-entry guard, that guard's "am I the
 * invoked entrypoint" check no longer reliably distinguishes "actually invoked" from "merely
 * inlined as a dependency" once bundled — it can fire for the wrong module, contaminating
 * `auto-pr-run.js`'s failure output with a different entrypoint's error event name.
 *
 * This test builds `dist/` fresh, then spawns each of the three related bin scripts as real
 * subprocesses with no relevant env vars set, and asserts each one fails with *only* its own
 * distinguishing error event name — never another entrypoint's.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");

const RUN_AUTO_PR_EVENT = "run_auto_pr_failed";
const GENERATE_CONTENT_EVENT = "generate_pr_content_failed";
const CREATE_OR_UPDATE_PR_EVENT = "create_or_update_pr_failed";

const ALL_EVENTS = [RUN_AUTO_PR_EVENT, GENERATE_CONTENT_EVENT, CREATE_OR_UPDATE_PR_EVENT];

function runBunDistScript(relativeDistPath: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [join(root, "dist", relativeDistPath)], {
    cwd: root,
    encoding: "utf8",
    // Deliberately strip all env vars (GITHUB_WORKSPACE, DEFAULT_BRANCH, GH_TOKEN, BRANCH, ...):
    // each entrypoint should fail on its *own* missing-env-var validation, not run any real logic.
    env: { PATH: process.env.PATH ?? "" },
  });
}

function expectOnlyOwnEvent(result: SpawnSyncReturns<string>, ownEvent: string): void {
  // A process that printed the expected event text but exited 0 would otherwise still pass.
  expect(result.status).not.toBe(0);
  const output = `${result.stdout}\n${result.stderr}`;
  expect(output).toContain(ownEvent);
  for (const event of ALL_EVENTS) {
    if (event !== ownEvent) {
      expect(output).not.toContain(event);
    }
  }
}

describe("dist/ bin scripts: cross-entrypoint isolation", () => {
  beforeAll(() => {
    const build = spawnSync(process.execPath, ["run", "build"], {
      cwd: root,
      encoding: "utf8",
    });
    if (build.status !== 0) {
      throw new Error(`bun run build failed:\n${build.stdout}\n${build.stderr}`);
    }
  });

  test("auto-pr-run.js fails with only its own event name (no args, no env)", () => {
    expectOnlyOwnEvent(runBunDistScript("workflow/auto-pr-run.js"), RUN_AUTO_PR_EVENT);
  });

  test("auto-pr-generate-content-cli.js fails with only its own event name (no args, no env)", () => {
    expectOnlyOwnEvent(
      runBunDistScript("workflow/auto-pr-generate-content-cli.js"),
      GENERATE_CONTENT_EVENT,
    );
  });

  test("auto-pr-create-or-update-pr-cli.js fails with only its own event name (no args, no env)", () => {
    expectOnlyOwnEvent(
      runBunDistScript("workflow/auto-pr-create-or-update-pr-cli.js"),
      CREATE_OR_UPDATE_PR_EVENT,
    );
  });
});
