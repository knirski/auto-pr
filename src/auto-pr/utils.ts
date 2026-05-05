/**
 * Auto-PR shell utilities. Effect-ful; FileSystemError, mapFsError, etc.
 * Pure helpers (unknownToMessage, toError) live in #core.
 */

import { Effect, Redacted, Schema } from "effect";
import { unknownToMessage as unknownToMessageCore } from "#core/string.js";

/** Redact path for logs: show basename only to avoid revealing home dir. */
export function redactPath(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Re-export for backward compatibility. Prefer #core/string. */
export const unknownToMessage = unknownToMessageCore;

/** Re-export for backward compatibility. Prefer #core/string. */
export { toError } from "#core/string.js";

/** Wrap value for log-safe display. In formatters use r.label ?? "<redacted>". */
function redactedForLog<T extends string>(
  value: T,
  redact: (v: T) => string,
): Redacted.Redacted<T> {
  return Redacted.make(value, { label: redact(value) });
}

/** File system error for auto-PR. Compatible with Schema.TaggedErrorClass. */
export class FileSystemError extends Schema.TaggedErrorClass<FileSystemError>()("FileSystemError", {
  path: Schema.Redacted(Schema.String),
  operation: Schema.String,
  message: Schema.String,
  fix: Schema.optional(Schema.String),
}) {}

/** Wrap raw FS errors as FileSystemError. Use with Effect.mapError. */
function wrapFs(path: string, op: string, fix?: string) {
  return (e: unknown) =>
    new FileSystemError({
      path: redactedForLog(path, redactPath),
      operation: op,
      message: unknownToMessageCore(e),
      fix,
    });
}

/** Pipe helper: map Effect errors to FileSystemError. */
export function mapFsError(path: string, op: string) {
  return <A, E, R>(eff: Effect.Effect<A, E, R>) => eff.pipe(Effect.mapError(wrapFs(path, op)));
}

/** Type guard for objects with _tag. */
function hasTag(obj: unknown): obj is { _tag: string } {
  return obj != null && typeof obj === "object" && "_tag" in obj;
}

/** Format unknown error for logs. For tagged errors, use formatFn; else unknownToMessage. */
export function errorToLogMessage(e: unknown, formatFn: (err: { _tag: string }) => string): string {
  if (hasTag(e)) {
    try {
      return formatFn(e);
    } catch {
      return unknownToMessageCore(e);
    }
  }
  return unknownToMessageCore(e);
}

function formatWithFix(base: string, fix?: string): string {
  return fix ? `${base}. Fix: ${fix}` : base;
}

/** Format FileSystemError for logs. */
export function formatFileSystemError(err: FileSystemError): string {
  return formatWithFix(
    `File system error: ${err.operation} at ${err.path.label ?? "<redacted>"} (${err.message})`,
    err.fix,
  );
}
