/**
 * Pure helpers for generated PR content.
 *
 * These functions shape model output and commit-derived fallback content without doing
 * filesystem, process, network, logging, or other shell work.
 */

import { pipe, Result, Schema } from "effect";
import { DescriptionParseError } from "#core/errors.js";
import type { CommitInfo } from "#core/fill-pr-template-core.js";
import { fitConventionalTitleToLengthLimit, getDescription } from "#core/fill-pr-template-core.js";
import { parseFirstJsonObject } from "#core/parse-model-json.js";
import { isBlank } from "#core/string.js";
import type { TitleDescription } from "#core/title-description.js";

export type GeneratedTitleDescription = {
  readonly title: string;
  readonly description: string;
};

export type ExistingPrTitleParseResult =
  | { readonly _tag: "Found"; readonly title: string }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Invalid"; readonly step: "parse" | "schema"; readonly reason: string };

const GhPrViewTitleSchema = Schema.Struct({
  title: Schema.String,
});

export function normalizeGeneratedRiskItems(risks: readonly string[]): readonly string[] {
  return risks.map((risk) => risk.trim().replace(/^-+\s*/, "")).filter((risk) => !isBlank(risk));
}

export function normalizeGeneratedBulletItems(items: readonly string[]): readonly string[] {
  return items.map((s) => s.trim().replace(/^-+\s*/, "")).filter((s) => !isBlank(s));
}

/** Callers must pre-normalize all array fields. */
export function buildGeneratedDescriptionBlock(value: {
  readonly motivation: readonly string[];
  readonly benefits: readonly string[];
  readonly risks: readonly string[];
  readonly notesForReviewers: string;
}): string {
  const sections = [`### Motivation\n${value.motivation.map((s) => `- ${s}`).join("\n")}`];
  if (value.benefits.length > 0) {
    sections.push(`### Benefits\n${value.benefits.map((s) => `- ${s}`).join("\n")}`);
  }
  sections.push(`### Risks\n${value.risks.map((risk) => `- ${risk}`).join("\n")}`);
  const notes = value.notesForReviewers.trim();
  if (!isBlank(notes)) {
    sections.push(`### Notes for reviewers\n${notes}`);
  }
  return sections.join("\n\n");
}

export function validateGeneratedContent(
  value: TitleDescription,
): Result.Result<GeneratedTitleDescription, DescriptionParseError> {
  const { motivation, benefits, notesForReviewers } = value;
  return pipe(
    fitConventionalTitleToLengthLimit(value.title),
    Result.flatMap((title) => {
      const normalizedMotivation = normalizeGeneratedBulletItems(motivation);
      if (normalizedMotivation.length === 0) {
        return Result.fail(new DescriptionParseError({ cause: "motivation is empty" }));
      }
      const normalizedBenefits = normalizeGeneratedBulletItems(benefits);
      const normalizedRisks = normalizeGeneratedRiskItems(value.risks);
      if (normalizedRisks.length === 0) {
        return Result.fail(new DescriptionParseError({ cause: "risks are empty" }));
      }
      const description = buildGeneratedDescriptionBlock({
        motivation: normalizedMotivation,
        benefits: normalizedBenefits,
        risks: normalizedRisks,
        notesForReviewers,
      });
      if (isBlank(description)) {
        return Result.fail(new DescriptionParseError({ cause: "description is empty" }));
      }
      return Result.succeed({ title, description });
    }),
  );
}

export function getFallbackTitleAndDescription(
  filtered: readonly CommitInfo[],
): GeneratedTitleDescription {
  const firstSubject = filtered[0]?.subject?.trim() ?? "";
  const title = Result.match(fitConventionalTitleToLengthLimit(firstSubject), {
    onSuccess: (t) => t,
    onFailure: () => "chore: update",
  });
  const bullets = filtered
    .map((c) => getDescription(c))
    .filter((s) => !isBlank(s))
    .slice(0, 8);
  const motivation = bullets.length > 0 ? bullets : [firstSubject];
  const description = buildGeneratedDescriptionBlock({
    motivation,
    benefits: [],
    risks: ["AI description unavailable — review changed files directly for risk assessment."],
    notesForReviewers: "",
  });
  return { title, description };
}

export function parseExistingPrTitleOutput(stdout: string): ExistingPrTitleParseResult {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    return { _tag: "Missing" };
  }

  const parsed = parseFirstJsonObject(trimmed);
  if (Result.isFailure(parsed)) {
    return { _tag: "Invalid", step: "parse", reason: parsed.failure.message };
  }

  const decoded = Schema.decodeUnknownResult(GhPrViewTitleSchema)(parsed.success);
  if (Result.isFailure(decoded)) {
    return { _tag: "Invalid", step: "schema", reason: String(decoded.failure) };
  }

  const title = decoded.success.title.trim();
  return title === "" ? { _tag: "Missing" } : { _tag: "Found", title };
}
