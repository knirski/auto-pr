/**
 * PullRequestClient — Tagless Final interface for GitHub PR operations.
 *
 * Live implementation uses GitHub REST (Octokit); workflow code depends on this capability instead of transport details.
 */

import type { Effect, Option } from "effect";
import type {
  PullRequestFailedError,
  PullRequestLookupError,
  PullRequestUrlParseError,
} from "#core/errors.js";

export type PullRequestInfo = {
  readonly number: number;
  readonly url: string;
  readonly title?: string | undefined;
};

export interface PullRequestClientService {
  /** Find an open PR for a branch. `Option.none` means no PR exists yet. */
  readonly findByBranch: (
    branch: string,
  ) => Effect.Effect<Option.Option<PullRequestInfo>, PullRequestLookupError>;

  /** Update an existing PR by number. */
  readonly update: (
    prNumber: number,
    title: string,
    bodyPath: string,
  ) => Effect.Effect<void, PullRequestFailedError>;

  /** Create a PR and return the created PR URL. */
  readonly create: (
    headBranch: string,
    baseBranch: string,
    title: string,
    bodyPath: string,
  ) => Effect.Effect<string, PullRequestFailedError | PullRequestUrlParseError>;
}
