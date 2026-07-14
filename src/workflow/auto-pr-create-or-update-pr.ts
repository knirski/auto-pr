/**
 * Create or update a PR. Workflow shell over PullRequestClient.
 *
 * Requires env: GH_TOKEN, BRANCH, DEFAULT_BRANCH, GITHUB_WORKSPACE. Reads `{GITHUB_WORKSPACE}/pr-title.txt` and `{GITHUB_WORKSPACE}/pr-body.md`.
 *
 * Validates required env at startup, then queries/updates/creates PRs via PullRequestClient.
 * Uses PR number for edits (more robust than branch name). Uses explicit head/base on create.
 *
 * This repo: bun run create-or-update-pr · installed: npx auto-pr-create-or-update-pr
 */

import { Duration, Effect, FileSystem, Option, Redacted, Schedule } from "effect";
import {
  AutoPrPlatformLayer,
  BodyFileNotFoundError,
  ChildProcessSpawnerLayer,
  CreateOrUpdatePrConfig,
  CreateOrUpdatePrConfigLayer,
  type FileSystemError,
  isTransientPrClientError,
  mapFsError,
  PullRequestClient,
  type PullRequestFailedError,
  runMain,
} from "#auto-pr";
import type { PullRequestLookupError, PullRequestUrlParseError } from "#core/errors.js";

// ─── Constants ────────────────────────────────────────────────────────────

const PR_CLIENT_RETRY_ATTEMPTS = 3;
const PR_CLIENT_RETRY_DELAY_MS = 5000;

function formatRetryDelay(delay: Duration.Duration): string {
  const delayMs = Duration.toMillis(delay);
  return delayMs >= 1000 ? `${delayMs / 1000}s` : `${delayMs}ms`;
}

function createPrClientRetrySchedule(
  branch: string,
  delay: Duration.Duration = Duration.millis(PR_CLIENT_RETRY_DELAY_MS),
) {
  const delayLabel = formatRetryDelay(delay);
  return Schedule.recurs(PR_CLIENT_RETRY_ATTEMPTS - 1).pipe(
    Schedule.addDelay(() => Effect.succeed(delay)),
    Schedule.tap(() =>
      Effect.logWarning({
        event: "create_or_update_pr",
        status: "pr_client_retry",
        branch,
        message: `GitHub PR request failed, retrying in about ${delayLabel}...`,
      }),
    ),
    // Effect v4 jitter keeps the delay within 80%-120%, so the log remains approximate.
    Schedule.jittered,
  );
}

function runPrClientWithRetry<R, E, A>(
  effect: Effect.Effect<A, E, R>,
  branch: string,
  retryDelay?: Duration.Duration,
): Effect.Effect<A, E, R> {
  return effect.pipe(
    Effect.retry({
      schedule: createPrClientRetrySchedule(branch, retryDelay),
      while: (error: E) => isTransientPrClientError(error),
    }),
    Effect.tapError(() =>
      Effect.logError({
        event: "create_or_update_pr",
        status: "failed_after_retries",
        branch,
        message: "GitHub PR request failed after 3 attempts",
      }),
    ),
  );
}

type CreateOrUpdatePrError =
  | PullRequestFailedError
  | BodyFileNotFoundError
  | FileSystemError
  | PullRequestLookupError
  | PullRequestUrlParseError;

type PullRequestClientLiveConfig = {
  ghToken: string;
  githubApiUrl?: string;
  ghHost?: string;
};

export function pullRequestClientLiveConfigFromParams(params: {
  ghToken: Redacted.Redacted<string>;
  githubApiUrl?: string;
  ghHost?: string;
}): PullRequestClientLiveConfig {
  return {
    ghToken: Redacted.value(params.ghToken),
    ...(params.githubApiUrl !== undefined ? { githubApiUrl: params.githubApiUrl } : {}),
    ...(params.ghHost !== undefined ? { ghHost: params.ghHost } : {}),
  };
}

/** Main pipeline. Exported for tests. */
export function runCreateOrUpdatePr(params: {
  branch: string;
  defaultBranch: string;
  title: string;
  bodyFile: string;
  workspace: string;
  retryDelay?: Duration.Duration;
}): Effect.Effect<void, CreateOrUpdatePrError, PullRequestClient | FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const prClient = yield* PullRequestClient;
    const bodyExists = yield* fs
      .exists(params.bodyFile)
      .pipe(mapFsError(params.bodyFile, "exists"));
    if (!bodyExists) {
      return yield* Effect.fail(new BodyFileNotFoundError({ path: params.bodyFile }));
    }

    const prInfo = yield* runPrClientWithRetry(
      prClient.findByBranch(params.branch),
      params.branch,
      params.retryDelay,
    );
    if (Option.isSome(prInfo)) {
      const { number: prNumber, url } = prInfo.value;
      yield* Effect.log({
        event: "create_or_update_pr",
        status: "updating",
        branch: params.branch,
        base: params.defaultBranch,
        prNumber,
        titlePreview: params.title.slice(0, 50),
      });
      yield* runPrClientWithRetry(
        prClient.update(prNumber, params.title, params.bodyFile),
        params.branch,
        params.retryDelay,
      );
      yield* Effect.log({
        event: "create_or_update_pr",
        status: "updated",
        url,
        branch: params.branch,
      });
    } else {
      yield* Effect.log({
        event: "create_or_update_pr",
        status: "creating",
        head: params.branch,
        base: params.defaultBranch,
        titlePreview: params.title.slice(0, 50),
      });
      const url = yield* runPrClientWithRetry(
        prClient.create(params.branch, params.defaultBranch, params.title, params.bodyFile),
        params.branch,
        params.retryDelay,
      );
      yield* Effect.log({
        event: "create_or_update_pr",
        status: "created",
        url,
        branch: params.branch,
      });
    }
  });
}

// ─── Entry ──────────────────────────────────────────────────────────────────

export const program = Effect.gen(function* () {
  const params = yield* CreateOrUpdatePrConfig;
  yield* runCreateOrUpdatePr(params).pipe(
    Effect.provide(
      PullRequestClient.Live(params.workspace, pullRequestClientLiveConfigFromParams(params)),
    ),
  );
}).pipe(
  Effect.provide(CreateOrUpdatePrConfigLayer),
  Effect.provide(AutoPrPlatformLayer),
  Effect.provide(ChildProcessSpawnerLayer),
);

if (import.meta.main) {
  runMain(program, "create_or_update_pr_failed");
}
