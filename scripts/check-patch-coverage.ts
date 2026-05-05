#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export type ChangedLine = {
  readonly file: string;
  readonly line: number;
};

export type MissingPatchCoverage = ChangedLine & {
  readonly hits: number;
};

export type CoverageByFile = Map<string, Map<number, number>>;

const root = join(import.meta.dir, "..");
const PATCH_COVERAGE_IGNORE_START = "patch-coverage-ignore-start";
const PATCH_COVERAGE_IGNORE_STOP = "patch-coverage-ignore-stop";

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isTrackedSourceFile(path: string): boolean {
  const normalized = normalizePath(path);
  return (
    normalized.startsWith("src/") && normalized.endsWith(".ts") && !normalized.endsWith(".d.ts")
  );
}

export function parseLcovInfo(content: string, repoRoot = root): CoverageByFile {
  const coverage: CoverageByFile = new Map();
  let currentFile: string | undefined;

  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      const rawPath = line.slice("SF:".length);
      const relativePath = rawPath.startsWith("/") ? relative(repoRoot, rawPath) : rawPath;
      currentFile = normalizePath(relativePath);
      if (!coverage.has(currentFile)) {
        coverage.set(currentFile, new Map());
      }
      continue;
    }

    if (currentFile === undefined || !line.startsWith("DA:")) {
      continue;
    }

    const [lineRaw, hitsRaw] = line.slice("DA:".length).split(",");
    const lineNumber = Number.parseInt(lineRaw ?? "", 10);
    const hits = Number.parseInt(hitsRaw ?? "", 10);
    if (Number.isFinite(lineNumber) && Number.isFinite(hits)) {
      coverage.get(currentFile)?.set(lineNumber, hits);
    }
  }

  return coverage;
}

export function parseAddedLinesFromUnifiedDiff(diff: string): ReadonlyArray<ChangedLine> {
  const changed: ChangedLine[] = [];
  let currentFile: string | undefined;
  let newLine: number | undefined;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      const path = normalizePath(line.slice("+++ b/".length));
      currentFile = isTrackedSourceFile(path) ? path : undefined;
      newLine = undefined;
      continue;
    }

    if (currentFile === undefined) {
      continue;
    }

    if (line.startsWith("@@ ")) {
      const match = line.match(/\+(\d+)(?:,\d+)?/);
      newLine = match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10);
      continue;
    }

    if (newLine === undefined || line.length === 0) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      changed.push({ file: currentFile, line: newLine });
      newLine += 1;
      continue;
    }

    if (!line.startsWith("-")) {
      newLine += 1;
    }
  }

  return changed;
}

export function findMissingPatchCoverage(
  changedLines: ReadonlyArray<ChangedLine>,
  coverage: CoverageByFile,
): ReadonlyArray<MissingPatchCoverage> {
  const missing: MissingPatchCoverage[] = [];

  for (const changed of changedLines) {
    const fileCoverage = coverage.get(changed.file);
    const hits = fileCoverage?.get(changed.line);
    if (hits === 0) {
      missing.push({ ...changed, hits });
    }
  }

  return missing;
}

export function parseIgnoredPatchCoverageLines(content: string): ReadonlySet<number> {
  const ignored = new Set<number>();
  let inIgnoredBlock = false;
  const lines = content.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    if (line.includes(PATCH_COVERAGE_IGNORE_START)) {
      inIgnoredBlock = true;
      continue;
    }
    if (line.includes(PATCH_COVERAGE_IGNORE_STOP)) {
      inIgnoredBlock = false;
      continue;
    }
    if (inIgnoredBlock) {
      ignored.add(index + 1);
    }
  }

  return ignored;
}

export function filterIgnoredChangedLines(
  changedLines: ReadonlyArray<ChangedLine>,
  readFileContent: (path: string) => string,
): ReadonlyArray<ChangedLine> {
  const ignoredByFile = new Map<string, ReadonlySet<number>>();
  return changedLines.filter((changed) => {
    let ignoredLines = ignoredByFile.get(changed.file);
    if (ignoredLines === undefined) {
      ignoredLines = parseIgnoredPatchCoverageLines(readFileContent(changed.file));
      ignoredByFile.set(changed.file, ignoredLines);
    }
    return !ignoredLines.has(changed.line);
  });
}

function readGitDiff(baseRef: string): string {
  return execFileSync("git", ["diff", "--unified=0", `${baseRef}...HEAD`, "--", "src"], {
    cwd: root,
    encoding: "utf8",
  });
}

function parseArgs(argv: ReadonlyArray<string>): { baseRef: string; coveragePath: string } {
  const [baseRef = "main", coveragePath = "coverage/lcov.info"] = argv;
  return { baseRef, coveragePath };
}

async function main() {
  const { baseRef, coveragePath } = parseArgs(Bun.argv.slice(2));
  const resolvedCoveragePath = join(root, coveragePath);
  if (!existsSync(resolvedCoveragePath)) {
    process.stderr.write(
      `patch coverage: ${coveragePath} not found. Run "bun test" before this check.\n`,
    );
    process.exit(1);
  }

  const diff = readGitDiff(baseRef);
  const changedLines = filterIgnoredChangedLines(parseAddedLinesFromUnifiedDiff(diff), (path) =>
    readFileSync(join(root, path), "utf8"),
  );
  const coverage = parseLcovInfo(await Bun.file(resolvedCoveragePath).text());
  const missing = findMissingPatchCoverage(changedLines, coverage);

  if (missing.length === 0) {
    process.stdout.write("patch coverage: all instrumented changed src lines are covered\n");
    return;
  }

  process.stderr.write("patch coverage: uncovered changed lines found\n");
  for (const item of missing) {
    process.stderr.write(`- ${item.file}:${item.line}\n`);
  }
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
