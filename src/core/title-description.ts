/**
 * Pure parser for structured AI PR content.
 *
 * The workflow asks providers for plain text because GitHub Models and some OpenAI-compatible
 * local servers do not support OpenAI `response_format: json_schema`. This module keeps the
 * tolerated text -> JSON object -> Schema decode path in core.
 */

import { pipe, Result, Schema } from "effect";
import { DescriptionParseError } from "#core/errors.js";
import { parseFirstJsonObject } from "#core/parse-model-json.js";

/** Schema for structured AI output: PR title plus structured review sections. */
export const TitleDescriptionSchema = Schema.Struct({
  title: Schema.String,
  motivation: Schema.Array(Schema.String),
  benefits: Schema.Array(Schema.String),
  risks: Schema.Array(Schema.String),
  notesForReviewers: Schema.String,
});

export type TitleDescription = Schema.Schema.Type<typeof TitleDescriptionSchema>;

/** Parse assistant reply -> JSON object -> {@link TitleDescriptionSchema}. */
export function parseTitleDescriptionFromAssistantText(
  text: string,
): Result.Result<TitleDescription, DescriptionParseError> {
  return pipe(
    parseFirstJsonObject(text),
    Result.mapError((e) => new DescriptionParseError({ cause: e.message })),
    Result.flatMap((parsed) =>
      pipe(
        Schema.decodeUnknownResult(TitleDescriptionSchema)(parsed),
        Result.mapError(
          (e) =>
            new DescriptionParseError({
              cause: String(e),
            }),
        ),
      ),
    ),
  );
}
