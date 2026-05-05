/**
 * FillPrTemplate — Tagless Final interface for PR title and body generation.
 *
 * Single implementation (Live). Interface enables layer composition and clear R
 * declaration. Use Layer.mock(FillPrTemplate) for workflow tests.
 */

import type { Effect, FileSystem, Path } from "effect";
import { Schema } from "effect";
import type { FileSystemError } from "#auto-pr/utils.js";
import type {
  FillPrTemplateValidationError,
  ParseError,
  PullRequestBodyBlankError,
  PullRequestTitleBlankError,
  TemplateRenderError,
} from "#core/errors.js";

/** Schema for FillPrTemplateParams. Use for runtime validation at boundaries. */
export const FillPrTemplateParamsSchema = Schema.Struct({
  logFilePath: Schema.String,
  filesFilePath: Schema.String,
  templatePath: Schema.String,
  descriptionFilePath: Schema.optionalKey(Schema.String),
  /** Drives `inferTypeOfChange` / breaking text (same role as the workflow’s generated PR title). */
  prTitleForTypeOfChange: Schema.optionalKey(Schema.String),
});

/** Parameters for loading commit log and files. */
export type FillPrTemplateParams = Schema.Schema.Type<typeof FillPrTemplateParamsSchema>;

export interface FillPrTemplateService {
  /** Returns PR title (first non-merge commit subject). Fails with PullRequestTitleBlankError if empty. */
  readonly getTitle: (
    params: FillPrTemplateParams,
  ) => Effect.Effect<
    string,
    ParseError | FileSystemError | PullRequestTitleBlankError,
    FileSystem.FileSystem
  >;

  /** Returns filled PR template body. Fails with PullRequestBodyBlankError if empty. */
  readonly getBody: (
    params: FillPrTemplateParams,
  ) => Effect.Effect<
    string,
    | FillPrTemplateValidationError
    | ParseError
    | FileSystemError
    | PullRequestBodyBlankError
    | TemplateRenderError,
    FileSystem.FileSystem | Path.Path
  >;
}
