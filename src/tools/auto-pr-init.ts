/**
 * Initialize auto-pr in the current directory.
 * Creates the two workflows (generate + create), PR template, .nvmrc, and
 * `.github/llama-server/Dockerfile`.
 *
 * Adopters: npx -p github:knirski/auto-pr auto-pr-init
 * This repo: bun run src/tools/auto-pr-init.ts
 *
 * This tool is a LOCAL FILE-COPY + MESSAGING tool only. It has NO GitHub API access: it does not
 * create the protected `app-credentials` environment, set deployment branch policies, or set
 * secrets. Those remain manual steps for every adopter (first-time or upgrading) — the tool's job
 * is to print unambiguous, complete instructions and, for the migration hazard below, to refuse to
 * report success silently.
 */

import { Effect, FileSystem, Path } from "effect";
import { Url } from "effect/unstable/http";
import { AutoPrLoggerLayer, AutoPrPlatformLayer, redactPath, runMain } from "#auto-pr";
import { getInitFileSpecs, isLegacyPushWorkflow } from "#core/init-core.js";

function copy(
  fs: FileSystem.FileSystem,
  pathApi: Path.Path,
  pkgRoot: string,
  from: string,
  to: string,
): Effect.Effect<void, Error, never> {
  return Effect.gen(function* () {
    const srcPath = pathApi.join(pkgRoot, from);
    const content = yield* fs.readFileString(srcPath);
    const toDir = pathApi.dirname(to);
    yield* fs.makeDirectory(toDir, { recursive: true });
    yield* fs.writeFileString(to, content);
  });
}

const NEXT_STEPS = `Next steps (required for the workflow to create PRs):

The privileged "create" phase now runs from a PROTECTED ENVIRONMENT (ADR 0016). Setup is manual —
auto-pr-init only copies files; it never touches your GitHub settings.

1. Create a GitHub App: https://github.com/settings/apps/new
   - Permissions: Contents, Pull requests (Read and write)
   - Webhook: Uncheck Active
2. Generate a private key (app settings → Private keys) and install the app on this repository.
3. Create a GitHub Actions ENVIRONMENT named "app-credentials"
   (Settings → Environments → New environment) BEFORE the workflows first run:
   - Deployment branch policy: "Selected branches and tags", allowing ONLY your default branch (e.g. main).
     This is the load-bearing control: it keeps the App secret unreachable from an ai/** branch.
   - Disable "Allow administrators to bypass configured protection rules".
   - (Required reviewers are NOT a meaningful control on a single-owner repo — do not rely on them.)
   - WARNING: if a workflow references this environment before you create it, GitHub silently
     auto-creates it with NO protection rules (it does not error) — you would get an UNPROTECTED
     environment. Create it first, then verify with scripts/check-app-credentials-environment.sh.
4. Add the App credentials to that ENVIRONMENT (not as plain repository secrets):
   - APP_ID (from app settings → About)
   - APP_PRIVATE_KEY (full contents of the .pem file)
   First-time setup: add them straight to the environment — there is no migration.

How generation is triggered now (push no longer starts it):
  - Manual (immediate) — run the "Auto-PR" workflow for one ai/** branch:
      gh workflow run auto-pr.yml -f branch=ai/your-branch
    (or Actions → Auto-PR → Run workflow, and set the "branch" input).
  - Automatic (ongoing) — a schedule discovers ai/** branches without an open PR roughly every
    15 minutes. Because GitHub's scheduled runs are best-effort, end-to-end latency is realistically
    10-30+ minutes, not seconds.
  - Advanced/opt-in — repository_dispatch can restore seconds-latency but requires you to run a
    webhook/App bridge yourself. It is documented (not built in) — see INTEGRATION.md.

See https://github.com/knirski/auto-pr/blob/main/docs/INTEGRATION.md for the full walkthrough,
including "Upgrading from the single-workflow version".`;

function runInit(cwd: string): Effect.Effect<void, Error, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathApi = yield* Path.Path;
    const scriptUrl = yield* Effect.fromResult(Url.fromString(import.meta.url)).pipe(
      Effect.mapError((e) => new Error(`Invalid import.meta.url: ${e.message}`)),
    );
    const scriptPath = yield* pathApi.fromFileUrl(scriptUrl);
    const pkgRoot = pathApi.join(pathApi.dirname(scriptPath), "..", "..");

    const specs = getInitFileSpecs();

    // Migration hazard guard (ADR 0016). runInit skips files that already exist, so an adopter who
    // upgraded the package and re-ran init would otherwise KEEP their old push-triggered auto-pr.yml
    // untouched while merely gaining auto-pr-create.yml alongside it — a half-migrated state that
    // fixes nothing but looks done. Detect that specific case BEFORE writing anything, refuse to
    // silently succeed, and change no files (never blindly clobber an adopter's workflow).
    for (const spec of specs) {
      if (spec.detectLegacy !== true) continue;
      const destPath = pathApi.join(cwd, spec.dest);
      const exists = yield* fs.exists(destPath);
      if (!exists) continue;
      const existing = yield* fs.readFileString(destPath);
      if (isLegacyPushWorkflow(existing)) {
        yield* Effect.logError({
          event: "init",
          status: "action_required",
          path: redactPath(destPath),
          message:
            "⚠ ACTION REQUIRED — migration incomplete. This is NOT a routine skip: the existing " +
            `${spec.dest} predates the auto-pr security fix (ADR 0016). It is still push-triggered ` +
            "and still contains the privileged create job that a same-repo branch author can " +
            "abuse. auto-pr-init did NOT modify or overwrite it. You must manually replace it with " +
            "the new push-free auto-pr.yml and add auto-pr-create.yml, then create the " +
            '"app-credentials" protected environment. See the "Upgrading from the single-workflow ' +
            'version" section of docs/INTEGRATION.md ' +
            "(https://github.com/knirski/auto-pr/blob/main/docs/INTEGRATION.md).",
        });
        return yield* Effect.fail(
          new Error(
            `Existing ${spec.dest} predates the auto-pr security fix (ADR 0016): it is still ` +
              'push-triggered and must be manually migrated (see the "Upgrading from the ' +
              'single-workflow version" section of docs/INTEGRATION.md). No files were changed. ' +
              "Re-run auto-pr-init after replacing it with the new push-free workflow.",
          ),
        );
      }
    }

    for (const spec of specs) {
      const destPath = pathApi.join(cwd, spec.dest);
      const exists = yield* fs.exists(destPath);
      if (exists) {
        yield* Effect.log({
          event: "init",
          status: "skipped",
          path: redactPath(destPath),
          reason: "already exists",
        });
      } else if (spec.content !== undefined) {
        yield* fs.writeFileString(destPath, spec.content);
        yield* Effect.log({ event: "init", status: "created", path: redactPath(destPath) });
      } else if (spec.from !== undefined) {
        yield* copy(fs, pathApi, pkgRoot, spec.from, destPath);
        yield* Effect.log({ event: "init", status: "created", path: redactPath(destPath) });
      }
    }

    yield* Effect.log({ event: "init", status: "next_steps", message: NEXT_STEPS });
  });
}

if (import.meta.main) {
  runMain(
    Effect.gen(function* () {
      const cwd = yield* Effect.sync(() => process.cwd());
      yield* runInit(cwd);
    }).pipe(Effect.provide(AutoPrPlatformLayer), Effect.provide(AutoPrLoggerLayer)),
    "init",
  );
}

export { runInit };
