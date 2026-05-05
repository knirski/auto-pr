/**
 * Pure validation for OpenAI-compatible base URLs (config / local provider).
 * Errors are plain objects; shell maps to AutoPrConfigError.
 */

import { Result } from "effect";

/** Error payload from {@link parseOpenAiCompatUrl}. Not a tagged domain error. */
export interface InvalidOpenAiCompatUrl {
  readonly reason: string;
}

/** Validate OpenAI-compatible base URL (http/https scheme required). */
export function parseOpenAiCompatUrl(raw: string): Result.Result<string, InvalidOpenAiCompatUrl> {
  if (raw.trim() === "") {
    return Result.fail({ reason: "empty" });
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return Result.fail({ reason: "not a valid URL" });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Result.fail({ reason: `scheme must be http(s), got ${parsed.protocol}` });
  }
  return Result.succeed(raw.trim());
}
