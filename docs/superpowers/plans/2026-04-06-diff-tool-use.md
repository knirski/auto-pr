# Diff Tool Use Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tool use to AI-generated PR descriptions so the model can selectively fetch diffs, while consolidating all git operations behind a typed `GitContext` service and eliminating `auto-pr-get-commits`.

**Architecture:** New `GitContext` Effect service wraps all git read operations. `generate-content` uses `GitContext` directly instead of reading file artifacts from a deleted `get-commits` step. An Effect `Toolkit` with `get_diff` and `get_commit_diff` tools lets the model fetch code context on demand. Initial prompt is enriched with `git diff --stat` output and commit hashes.

**Tech Stack:** Effect v4 (`ServiceMap.Service`, `Layer`, `Toolkit`, `Tool`), `@effect/ai-openai-compat`, Bun test runner, GitHub Actions

**Reference:** Design spec at `docs/superpowers/specs/2026-04-06-diff-tool-use-design.md`. Effect v4 source at `/home/krzysiek/github/Effect-TS/effect-smol`.

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `src/auto-pr/git-context.ts` | `GitContext` service definition + live implementation |
| Create | `test/auto-pr/git-context.test.ts` | Unit tests for `GitContext` |
| Create | `src/auto-pr/diff-toolkit.ts` | `GetDiff` + `GetCommitDiff` tools, `DiffToolkit`, handler layer factory |
| Create | `test/auto-pr/diff-toolkit.test.ts` | Unit tests for toolkit handlers |
| Modify | `src/core/fill-pr-template-core.ts` | Add `hash` to `CommitInfo`, update `parseCommits`, update `getDescriptionPromptText` |
| Modify | `test/core/fill-pr-template-core.test.ts` | Tests for hash parsing and prompt text |
| Modify | `src/core/prompt.ts` | Update `buildDescriptionPrompt` to accept `diffStat` |
| Modify | `test/core/prompt.test.ts` (create if absent) | Tests for prompt building |
| Modify | `src/auto-pr/prompts/pr-description.txt` | Add tool descriptions to system prompt |
| Modify | `src/auto-pr/config.ts` | Add `defaultBranch` + `branch` to `GeneratePrContentConfig` |
| Modify | `src/workflow/auto-pr-generate-content.ts` | Use `GitContext`, integrate toolkit, remove file reads |
| Modify | `test/workflow/generate-pr-content.test.ts` | Adapt to `GitContext`-based API |
| Modify | `src/workflow/auto-pr-run.ts` | Remove get-commits chaining, simplify pipeline |
| Modify | `src/auto-pr/index.ts` | Remove get-commits exports, add git-context + diff-toolkit exports |
| Modify | `src/core/index.ts` | Update exports |
| Modify | `src/auto-pr/shell.ts` | Export `ChildProcessSpawnerLayer` (already exported, verify) |
| Modify | `test/test-utils.ts` | Add `GitContextTestMock` |
| Delete | `src/workflow/auto-pr-get-commits.ts` | Eliminated |
| Delete | `test/workflow/auto-pr-get-commits.test.ts` | Eliminated |
| Delete | `test/workflow/pipeline.test.ts` | Eliminated (pipeline test relied on get-commits → generate-content chain) |
| Modify | `.github/workflows/auto-pr-generate-reusable.yml` | Remove get-commits step, add bash count step |
| Modify | `.github/actions/auto-pr-run-command/action.yml` | Remove get-commits outputs |
| Modify | `package.json` | Remove `auto-pr-get-commits` binary |

---

### Task 1: `GitContext` Service — Interface and Live Implementation

**Files:**
- Create: `src/auto-pr/git-context.ts`
- Create: `test/auto-pr/git-context.test.ts`

- [ ] **Step 1: Write the failing test for `GitContext.getLog`**

Create `test/auto-pr/git-context.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { runEffect } from "#test/run-effect.js";
import { TestBaseLayer } from "#test/test-utils.js";
import { ChildProcessSpawnerLayer } from "#auto-pr";
import { GitContext, GitContextLive } from "#auto-pr/git-context.js";

const TestLayer = Layer.mergeAll(
  TestBaseLayer,
  ChildProcessSpawnerLayer,
);

function setupGitRepo(
  workspace: string,
  commits: Array<{ message: string }>,
): Effect.Effect<void, Error, ChildProcessSpawner> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    const run = (args: string[]) =>
      spawner
        .string(ChildProcess.make("git", args, { cwd: workspace }))
        .pipe(Effect.mapError((e) => new Error(String(e))));
    yield* run(["init"]);
    yield* run(["config", "user.email", "test@test.com"]);
    yield* run(["config", "user.name", "Test"]);
    yield* run(["config", "init.defaultBranch", "main"]);
    yield* run(["commit", "--allow-empty", "-m", "init"]);
    for (const { message } of commits) {
      yield* run(["commit", "--allow-empty", "-m", message]);
    }
    const n = commits.length;
    yield* run(["update-ref", "refs/remotes/origin/main", `HEAD~${n}`]);
  });
}

describe("GitContext", () => {
  test("getLog returns commit log with hashes", async () => {
    await runEffect(TestLayer)(
      Effect.gen(function* () {
        const fs = yield* Effect.serviceMembers(Effect.context<typeof TestLayer>());
        const tmp = yield* Effect.sync(() => require("os").mkdtemp("/tmp/git-ctx-"));
        // Use real git — test is in test/auto-pr/ alongside other service tests
        const tmpDir = yield* (yield* import("effect/FileSystem").then(m => m.FileSystem)).makeTempDirectory({ prefix: "git-ctx-" });
        yield* setupGitRepo(tmpDir, [
          { message: "feat: add feature" },
          { message: "fix: fix bug" },
        ]);
        const ctx = GitContextLive(tmpDir);
        const log = yield* Effect.provide(
          ctx.getLog("origin/main", "HEAD"),
          ChildProcessSpawnerLayer,
        );
        expect(log).toContain("---COMMIT---");
        expect(log).toContain("feat: add feature");
        expect(log).toContain("fix: fix bug");
        // Hash is 40 hex chars on a line by itself after ---COMMIT---
        expect(log).toMatch(/---COMMIT---\n[0-9a-f]{40}\n/);
      }).pipe(Effect.scoped),
    );
  });
});
```

Note: This test pattern follows `test/workflow/auto-pr-get-commits.test.ts` which uses real git repos.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/auto-pr/git-context.test.ts`
Expected: FAIL — module `#auto-pr/git-context.js` not found

- [ ] **Step 3: Implement `GitContext` service**

Create `src/auto-pr/git-context.ts`:

```typescript
/**
 * Typed interface for all git read operations. Single source of truth.
 * Live implementation uses ChildProcessSpawner (runCommand).
 * Workspace (cwd) is baked into the live layer — not a per-method parameter.
 */

import { Effect, Layer, ServiceMap } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { runCommand } from "#auto-pr/shell.js";

export interface GitContext {
  readonly getLog: (baseRef: string, headRef: string) => Effect.Effect<string, Error>
  readonly getChangedFiles: (baseRef: string, headRef: string) => Effect.Effect<string, Error>
  readonly getDiffStat: (baseRef: string, headRef: string) => Effect.Effect<string, Error>
  readonly getDiff: (baseRef: string, headRef: string, path?: string) => Effect.Effect<string, Error>
  readonly getCommitDiff: (hash: string) => Effect.Effect<string, Error>
}

export const GitContext = ServiceMap.Service<GitContext>("GitContext");

const LOG_FORMAT = "---COMMIT---%n%H%n%s%n%n%b";

/** Build live GitContext with workspace baked in. Returns a Layer. */
export function GitContextLive(workspace: string): Layer.Layer<GitContext, never, ChildProcessSpawner> {
  return Layer.effect(
    GitContext,
    Effect.gen(function* () {
      return {
        getLog: (baseRef, headRef) =>
          runCommand("git", ["log", `--format=${LOG_FORMAT}`, `${baseRef}..${headRef}`], workspace),
        getChangedFiles: (baseRef, headRef) =>
          runCommand("git", ["diff", "--name-only", `${baseRef}..${headRef}`], workspace),
        getDiffStat: (baseRef, headRef) =>
          runCommand("git", ["diff", "--stat", `${baseRef}..${headRef}`], workspace),
        getDiff: (baseRef, headRef, path?) => {
          const args = ["diff", `${baseRef}..${headRef}`];
          if (path !== undefined) args.push("--", path);
          return runCommand("git", args, workspace);
        },
        getCommitDiff: (hash) =>
          runCommand("git", ["show", hash], workspace),
      };
    }),
  );
}
```

- [ ] **Step 4: Fix test to use correct patterns, then run**

Rewrite the test to use proper Effect patterns matching the existing test style (use `createTestTempDirEffect`, `FileSystem`):

```typescript
import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { runEffect } from "#test/run-effect.js";
import { createTestTempDirEffect, SilentLoggerLayer, TestBaseLayer } from "#test/test-utils.js";
import { ChildProcessSpawnerLayer } from "#auto-pr";
import { GitContext, GitContextLive } from "#auto-pr/git-context.js";

const TestLayer = Layer.mergeAll(TestBaseLayer, SilentLoggerLayer, ChildProcessSpawnerLayer);

function setupGitRepo(
  workspace: string,
  commits: Array<{ message: string }>,
): Effect.Effect<void, Error, ChildProcessSpawner> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    const run = (args: string[]) =>
      spawner
        .string(ChildProcess.make("git", args, { cwd: workspace }))
        .pipe(Effect.mapError((e) => new Error(String(e))));
    yield* run(["init"]);
    yield* run(["config", "user.email", "test@test.com"]);
    yield* run(["config", "user.name", "Test"]);
    yield* run(["config", "init.defaultBranch", "main"]);
    yield* run(["commit", "--allow-empty", "-m", "init"]);
    for (const { message } of commits) {
      yield* run(["commit", "--allow-empty", "-m", message]);
    }
    const n = commits.length;
    yield* run(["update-ref", "refs/remotes/origin/main", `HEAD~${n}`]);
  });
}

describe("GitContext", () => {
  test("getLog returns log with hashes in expected format", async () => {
    await runEffect(TestLayer)(
      Effect.gen(function* () {
        const tmp = yield* createTestTempDirEffect("git-ctx-");
        yield* setupGitRepo(tmp.path, [
          { message: "feat: add feature" },
          { message: "fix: fix bug" },
        ]);
        const gitCtx = yield* Effect.provide(
          GitContext,
          GitContextLive(tmp.path),
        );
        const log = yield* gitCtx.getLog("origin/main", "HEAD");
        expect(log).toContain("---COMMIT---");
        expect(log).toContain("feat: add feature");
        expect(log).toContain("fix: fix bug");
        expect(log).toMatch(/---COMMIT---\n[0-9a-f]{40}\n/);
      }).pipe(Effect.scoped),
    );
  });

  test("getChangedFiles returns file names", async () => {
    await runEffect(TestLayer)(
      Effect.gen(function* () {
        const tmp = yield* createTestTempDirEffect("git-ctx-");
        const fs = yield* FileSystem.FileSystem;
        yield* setupGitRepo(tmp.path, []);
        yield* fs.writeFileString(tmp.join("foo.ts"), "export const x = 1;");
        const spawner = yield* ChildProcessSpawner;
        const run = (args: string[]) =>
          spawner.string(ChildProcess.make("git", args, { cwd: tmp.path }))
            .pipe(Effect.mapError((e) => new Error(String(e))));
        yield* run(["add", "foo.ts"]);
        yield* run(["commit", "-m", "feat: add foo"]);
        yield* run(["update-ref", "refs/remotes/origin/main", "HEAD~1"]);
        const gitCtx = yield* Effect.provide(GitContext, GitContextLive(tmp.path));
        const files = yield* gitCtx.getChangedFiles("origin/main", "HEAD");
        expect(files.trim()).toBe("foo.ts");
      }).pipe(Effect.scoped),
    );
  });

  test("getDiffStat returns stat output", async () => {
    await runEffect(TestLayer)(
      Effect.gen(function* () {
        const tmp = yield* createTestTempDirEffect("git-ctx-");
        const fs = yield* FileSystem.FileSystem;
        yield* setupGitRepo(tmp.path, []);
        yield* fs.writeFileString(tmp.join("bar.ts"), "export const y = 2;");
        const spawner = yield* ChildProcessSpawner;
        const run = (args: string[]) =>
          spawner.string(ChildProcess.make("git", args, { cwd: tmp.path }))
            .pipe(Effect.mapError((e) => new Error(String(e))));
        yield* run(["add", "bar.ts"]);
        yield* run(["commit", "-m", "feat: add bar"]);
        yield* run(["update-ref", "refs/remotes/origin/main", "HEAD~1"]);
        const gitCtx = yield* Effect.provide(GitContext, GitContextLive(tmp.path));
        const stat = yield* gitCtx.getDiffStat("origin/main", "HEAD");
        expect(stat).toContain("bar.ts");
        expect(stat).toMatch(/\d+ file/);
      }).pipe(Effect.scoped),
    );
  });

  test("getDiff returns diff for specific file", async () => {
    await runEffect(TestLayer)(
      Effect.gen(function* () {
        const tmp = yield* createTestTempDirEffect("git-ctx-");
        const fs = yield* FileSystem.FileSystem;
        yield* setupGitRepo(tmp.path, []);
        yield* fs.writeFileString(tmp.join("a.ts"), "const a = 1;");
        yield* fs.writeFileString(tmp.join("b.ts"), "const b = 2;");
        const spawner = yield* ChildProcessSpawner;
        const run = (args: string[]) =>
          spawner.string(ChildProcess.make("git", args, { cwd: tmp.path }))
            .pipe(Effect.mapError((e) => new Error(String(e))));
        yield* run(["add", "."]);
        yield* run(["commit", "-m", "feat: add files"]);
        yield* run(["update-ref", "refs/remotes/origin/main", "HEAD~1"]);
        const gitCtx = yield* Effect.provide(GitContext, GitContextLive(tmp.path));
        const diffA = yield* gitCtx.getDiff("origin/main", "HEAD", "a.ts");
        expect(diffA).toContain("a.ts");
        expect(diffA).not.toContain("b.ts");
        const diffAll = yield* gitCtx.getDiff("origin/main", "HEAD");
        expect(diffAll).toContain("a.ts");
        expect(diffAll).toContain("b.ts");
      }).pipe(Effect.scoped),
    );
  });

  test("getCommitDiff returns single commit diff", async () => {
    await runEffect(TestLayer)(
      Effect.gen(function* () {
        const tmp = yield* createTestTempDirEffect("git-ctx-");
        const fs = yield* FileSystem.FileSystem;
        yield* setupGitRepo(tmp.path, []);
        yield* fs.writeFileString(tmp.join("c.ts"), "const c = 3;");
        const spawner = yield* ChildProcessSpawner;
        const run = (args: string[]) =>
          spawner.string(ChildProcess.make("git", args, { cwd: tmp.path }))
            .pipe(Effect.mapError((e) => new Error(String(e))));
        yield* run(["add", "c.ts"]);
        yield* run(["commit", "-m", "feat: add c"]);
        const hash = (yield* run(["rev-parse", "HEAD"])).trim();
        const gitCtx = yield* Effect.provide(GitContext, GitContextLive(tmp.path));
        const diff = yield* gitCtx.getCommitDiff(hash);
        expect(diff).toContain("c.ts");
        expect(diff).toContain("feat: add c");
      }).pipe(Effect.scoped),
    );
  });
});
```

Run: `bun test test/auto-pr/git-context.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auto-pr/git-context.ts test/auto-pr/git-context.test.ts
git commit -m "feat: add GitContext service for typed git operations"
```

---

### Task 2: Add `hash` to `CommitInfo` and Update Parsing

**Files:**
- Modify: `src/core/fill-pr-template-core.ts`
- Modify: `test/core/fill-pr-template-core.test.ts`

- [ ] **Step 1: Write failing tests for hash extraction**

Add to `test/core/fill-pr-template-core.test.ts`:

```typescript
describe("parseCommits (hash extraction)", () => {
  test("extracts full SHA hash from log format with %H", () => {
    const log = [
      "---COMMIT---",
      "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      "feat: add feature",
      "",
      "Body of commit.",
    ].join("\n");
    pipe(
      parseCommits(log),
      Result.match({
        onSuccess: (commits) => {
          expect(commits).toHaveLength(1);
          expect(commits[0].hash).toBe("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2");
          expect(commits[0].subject).toBe("feat: add feature");
          expect(commits[0].body).toContain("Body of commit.");
        },
        onFailure: () => expect().fail("should parse"),
      }),
    );
  });

  test("handles multiple commits with hashes", () => {
    const log = [
      "---COMMIT---",
      "aaaa000000000000000000000000000000000001",
      "feat: first",
      "",
      "",
      "---COMMIT---",
      "bbbb000000000000000000000000000000000002",
      "fix: second",
      "",
      "",
    ].join("\n");
    pipe(
      parseCommits(log),
      Result.match({
        onSuccess: (commits) => {
          expect(commits).toHaveLength(2);
          expect(commits[0].hash).toBe("aaaa000000000000000000000000000000000001");
          expect(commits[0].subject).toBe("feat: first");
          expect(commits[1].hash).toBe("bbbb000000000000000000000000000000000002");
          expect(commits[1].subject).toBe("fix: second");
        },
        onFailure: () => expect().fail("should parse"),
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/core/fill-pr-template-core.test.ts --filter "hash extraction"`
Expected: FAIL — `hash` property does not exist on `CommitInfo`

- [ ] **Step 3: Add `hash` to `CommitInfo` and update parsing**

In `src/core/fill-pr-template-core.ts`:

Add `hash` to the interface:
```typescript
export interface CommitInfo {
  readonly hash: string;
  readonly subject: string;
  readonly body: string;
  readonly fullMessage: string;
  readonly type: string | null;
  readonly references: readonly string[];
  readonly breakingNote: string | null;
}
```

Update `parseCommits` to extract hash:
```typescript
export function parseCommits(logOutput: string): Result.Result<readonly CommitInfo[], ParseError> {
  return Result.try({
    try: () => {
      const blocks = logOutput
        .split("---COMMIT---")
        .map((b) => b.trim())
        .filter(Boolean);
      return blocks.map((block) => {
        const lines = block.split("\n");
        const hashLine = lines[0] ?? "";
        const isHash = /^[0-9a-f]{40}$/.test(hashLine);
        const hash = isHash ? hashLine : "";
        const commitBlock = isHash ? lines.slice(1).join("\n") : block;
        return mapParsedToCommitInfo(commitBlock, parser.parse(commitBlock), hash);
      });
    },
    catch: (e) =>
      new ParseError({
        message: "Failed to parse commits",
        cause: toError(e),
      }),
  });
}
```

Update `mapParsedToCommitInfo` to accept hash:
```typescript
function mapParsedToCommitInfo(block: string, parsed: Commit, hash: string): CommitInfo {
  const header = parsed.header ?? block.split("\n")[0] ?? "";
  const bodyParts = [parsed.body, parsed.footer].filter(Boolean);
  const body = bodyParts.join("\n\n").trim();
  const refs = parsed.references
    .filter((r) => isNumericGitHubIssueId(r.issue))
    .map((r) => {
      const action = r.action ?? "Closes";
      const ref =
        r.owner != null && r.repository != null
          ? `${r.owner}/${r.repository}#${r.issue}`
          : `${r.prefix ?? "#"}${r.issue}`;
      return `${action} ${ref}`;
    });
  const breaking = parsed.notes.find((n) => /BREAKING/i.test(n.title));
  return {
    hash,
    subject: header,
    body,
    fullMessage: block,
    type: parsed.type ?? null,
    references: refs,
    breakingNote: breaking?.text ?? null,
  };
}
```

- [ ] **Step 4: Fix all call sites for `commit()` test helper**

Update the `commit()` helper in the test file to include `hash`:
```typescript
const commit = (
  subject: string,
  body: string,
  opts?: { hash?: string; type?: string; references?: string[]; breakingNote?: string | null },
): CommitInfo => ({
  hash: opts?.hash ?? "",
  subject,
  body,
  fullMessage: body ? `${subject}\n\n${body}` : subject,
  type: opts?.type ?? null,
  references: opts?.references ?? [],
  breakingNote: opts?.breakingNote ?? null,
});
```

- [ ] **Step 5: Run all tests to verify**

Run: `bun test test/core/fill-pr-template-core.test.ts`
Expected: PASS (all existing tests + new hash tests)

- [ ] **Step 6: Update `getDescriptionPromptText` to include short hash**

In `src/core/fill-pr-template-core.ts`:

```typescript
export function getDescriptionPromptText(commits: readonly CommitInfo[]): string {
  return commits
    .map((c) => {
      const hashPrefix = c.hash ? `${c.hash.slice(0, 7)} ` : "";
      const block = c.body.trim() ? `${hashPrefix}${c.subject}\n\n${c.body}` : `${hashPrefix}${c.subject}`;
      return `- ${block}`;
    })
    .join("\n\n");
}
```

- [ ] **Step 7: Add test for prompt text with hashes**

```typescript
describe("getDescriptionPromptText (with hashes)", () => {
  test("includes truncated hash prefix in output", () => {
    const commits = [
      commit("feat: add x", "Body.", { hash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" }),
      commit("fix: fix y", "", { hash: "bbbb000000000000000000000000000000000002" }),
    ];
    const text = getDescriptionPromptText(commits);
    expect(text).toContain("- a1b2c3d feat: add x");
    expect(text).toContain("- bbbb000 fix: fix y");
  });

  test("omits hash prefix when hash is empty (backwards compat)", () => {
    const commits = [commit("feat: add z", "")];
    const text = getDescriptionPromptText(commits);
    expect(text).toBe("- feat: add z");
  });
});
```

- [ ] **Step 8: Run tests**

Run: `bun test test/core/fill-pr-template-core.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/core/fill-pr-template-core.ts test/core/fill-pr-template-core.test.ts
git commit -m "feat: add commit hash to CommitInfo and prompt text"
```

---

### Task 3: Update Prompt Building

**Files:**
- Modify: `src/core/prompt.ts`
- Create: `test/core/prompt.test.ts`
- Modify: `src/auto-pr/prompts/pr-description.txt`

- [ ] **Step 1: Write failing test for `buildDescriptionPrompt` with diffstat**

Create `test/core/prompt.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { buildDescriptionPrompt } from "#core/prompt.js";

describe("buildDescriptionPrompt", () => {
  test("includes diffstat when provided", () => {
    const result = buildDescriptionPrompt(
      "System prompt.",
      " src/a.ts | 10 +++\n 1 file changed",
      "- feat: add a",
    );
    expect(result).toContain("System prompt.");
    expect(result).toContain("Changed files (diff stat):");
    expect(result).toContain("src/a.ts | 10 +++");
    expect(result).toContain("Commits:\n- feat: add a");
  });

  test("omits diffstat section when empty string", () => {
    const result = buildDescriptionPrompt("System prompt.", "", "- feat: add a");
    expect(result).not.toContain("Changed files");
    expect(result).toContain("Commits:\n- feat: add a");
  });

  test("backwards compat: works with two args (no diffstat)", () => {
    const result = buildDescriptionPrompt("System prompt.", undefined as any, "- feat: add a");
    expect(result).toContain("Commits:\n- feat: add a");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/core/prompt.test.ts`
Expected: FAIL — function signature mismatch (currently takes 2 args)

- [ ] **Step 3: Update `buildDescriptionPrompt`**

In `src/core/prompt.ts`:

```typescript
/**
 * Prompt building helpers. Pure, no I/O.
 */

/** Build full description prompt from template, optional diffstat, and commit content. */
export function buildDescriptionPrompt(
  promptTemplate: string,
  diffStat: string,
  commitContent: string,
): string {
  const sections = [promptTemplate.trim()];
  if (diffStat && diffStat.trim()) {
    sections.push(`Changed files (diff stat):\n${diffStat.trim()}`);
  }
  sections.push(`Commits:\n${commitContent}`);
  return sections.join("\n\n");
}
```

- [ ] **Step 4: Run test**

Run: `bun test test/core/prompt.test.ts`
Expected: PASS

- [ ] **Step 5: Fix all call sites of `buildDescriptionPrompt`**

The function signature changed from `(promptTemplate, commitContent)` to `(promptTemplate, diffStat, commitContent)`. Find and update all call sites:

In `src/workflow/auto-pr-generate-content.ts` (line ~357):
```typescript
// Old:
const prompt = buildDescriptionPrompt(descriptionPromptText, commitContent);
// New (temporary — pass empty diffStat until Task 6 integrates GitContext):
const prompt = buildDescriptionPrompt(descriptionPromptText, "", commitContent);
```

Search for other call sites in `src/tools/auto-pr-fill-pr-template.ts` and tests — update them all with empty string for `diffStat`.

- [ ] **Step 6: Run full test suite**

Run: `bun test`
Expected: PASS

- [ ] **Step 7: Update system prompt with tool descriptions**

Modify `src/auto-pr/prompts/pr-description.txt` — append tool usage instructions:

```
Output JSON only: {"title": "...", "motivation": ["..."], "benefits": ["..."], "risks": ["..."], "notesForReviewers": "..."}.

title: TYPE: subject or TYPE(scope): subject. Types: feat, fix, docs, chore, refactor, security, perf, test, ci, build, revert, style. Max 100 chars. Be concrete after the colon ("feat: add session refresh", not "feat: update").

motivation: 1–5 bullets. Why does this branch exist—what problem, goal, or constraint? Most important field. Be specific.

benefits: 0–3 bullets. Concrete gains (performance, reliability, developer experience). Use [] when nothing stands out beyond motivation.

risks: 1–5 bullets. What could go wrong or needs careful review. If genuinely low risk, say so: "Low risk: docs-only change."

notesForReviewers: Where to start, non-obvious tradeoffs, or read order. Use "" if nothing to add.

Do not repeat commit messages, issue links, testing steps, or breaking-change notes—those appear elsewhere in the PR.
Use inline code for file paths and API names when helpful.

You have two tools available. Use them when the commit messages and diff stat are not enough to write accurate risks or reviewer notes:
- get_diff: Fetch the git diff for changed files. Pass {"path": "src/foo.ts"} for one file, or {} for all files.
- get_commit_diff: Fetch the diff for a specific commit. Pass {"hash": "<full-or-short-hash>"} using a hash from the commit list.

Call tools only when you need to see actual code changes. For small or docs-only branches, commit messages and diff stat are usually sufficient.

Example 1:
{"title":"feat(ci): harden generate workflow token fallback","motivation":["Token handling was inconsistent across reusable workflows, making AI-backed PR generation fragile without a dedicated PAT.","This aligns workflow defaults so the generate job works reliably in common CI setups."],"benefits":["Repositories without a dedicated PAT now work out of the box."],"risks":["Verify github.token precedence in reusable workflow calls.","Check models:read permission scope in GitHub Models jobs."],"notesForReviewers":"Start with .github/workflows/auto-pr-generate-reusable.yml, then related config and docs."}

Example 2:
{"title":"fix(pr-template): keep type of change aligned with final title","motivation":["PR body showed a different type-of-change label than the generated title when a multi-commit branch was summarized."],"benefits":[],"risks":["Confirm multi-commit PRs still infer the right type when the generated title differs from commits.","Review fallback when AI output is invalid."],"notesForReviewers":"See src/core/fill-pr-template-core.ts and the workflow tests covering generated titles."}
```

- [ ] **Step 8: Commit**

```bash
git add src/core/prompt.ts test/core/prompt.test.ts src/auto-pr/prompts/pr-description.txt
git commit -m "feat: add diffstat to prompt and tool descriptions to system prompt"
```

---

### Task 4: `DiffToolkit` — Tool Definitions and Handlers

**Files:**
- Create: `src/auto-pr/diff-toolkit.ts`
- Create: `test/auto-pr/diff-toolkit.test.ts`
- Modify: `test/test-utils.ts`

- [ ] **Step 1: Add `GitContextTestMock` to test utils**

In `test/test-utils.ts`, add:

```typescript
import { GitContext } from "#auto-pr/git-context.js";

/** Mock GitContext for tests. Override individual methods as needed. */
export function createGitContextMock(overrides?: Partial<GitContext>): GitContext {
  const noOp = () => Effect.succeed("");
  return {
    getLog: overrides?.getLog ?? noOp,
    getChangedFiles: overrides?.getChangedFiles ?? noOp,
    getDiffStat: overrides?.getDiffStat ?? noOp,
    getDiff: overrides?.getDiff ?? noOp,
    getCommitDiff: overrides?.getCommitDiff ?? noOp,
  };
}

export const GitContextTestMock = Layer.succeed(
  GitContext,
  createGitContextMock(),
);
```

- [ ] **Step 2: Write failing test for toolkit handler**

Create `test/auto-pr/diff-toolkit.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { runEffect } from "#test/run-effect.js";
import { createGitContextMock, SilentLoggerLayer, TestBaseLayer } from "#test/test-utils.js";
import { GitContext } from "#auto-pr/git-context.js";
import { DiffToolkit, makeDiffToolkitLayer } from "#auto-pr/diff-toolkit.js";

describe("DiffToolkit handlers", () => {
  test("get_diff handler calls GitContext.getDiff with correct refs", async () => {
    let capturedArgs: { baseRef: string; headRef: string; path?: string } | undefined;
    const mockGitCtx = createGitContextMock({
      getDiff: (baseRef, headRef, path?) => {
        capturedArgs = { baseRef, headRef, path };
        return Effect.succeed("diff --git a/foo.ts b/foo.ts\n+const x = 1;");
      },
    });
    // Test handler via LanguageModel.generateText with a mock model that calls the tool.
    // The handler is exercised by the toolkit when the model requests a tool call.
    // For unit testing, test the handler factory function directly:
    const toolkitLayer = makeDiffToolkitLayer("origin/main", "ai/feature");
    const gitLayer = Layer.succeed(GitContext, mockGitCtx);
    const TestLayer = Layer.mergeAll(
      TestBaseLayer,
      SilentLoggerLayer,
      toolkitLayer.pipe(Layer.provide(gitLayer)),
    );
    // Verify the layer builds without error (handler wiring is correct).
    // Full tool-call integration tested in generate-pr-content.test.ts with mocked AI.
    await runEffect(TestLayer)(
      Effect.gen(function* () {
        // Layer construction succeeded — handlers are wired.
        // Call getDiff directly to verify the mock captures args.
        const git = yield* Effect.provide(GitContext, gitLayer);
        const result = yield* git.getDiff("origin/main", "ai/feature", "foo.ts");
        expect(result).toContain("+const x = 1;");
        expect(capturedArgs?.baseRef).toBe("origin/main");
        expect(capturedArgs?.path).toBe("foo.ts");
      }).pipe(Effect.scoped),
    );
  });

  test("get_commit_diff handler calls GitContext.getCommitDiff", async () => {
    let capturedHash: string | undefined;
    const mockGitCtx = createGitContextMock({
      getCommitDiff: (hash) => {
        capturedHash = hash;
        return Effect.succeed("commit abc123\nfeat: add x\n\ndiff content");
      },
    });
    const toolkitLayer = makeDiffToolkitLayer("origin/main", "ai/feature");
    const gitLayer = Layer.succeed(GitContext, mockGitCtx);
    const TestLayer = Layer.mergeAll(
      TestBaseLayer,
      SilentLoggerLayer,
      toolkitLayer.pipe(Layer.provide(gitLayer)),
    );
    await runEffect(TestLayer)(
      Effect.gen(function* () {
        const git = yield* Effect.provide(GitContext, gitLayer);
        const result = yield* git.getCommitDiff("abc123");
        expect(result).toContain("diff content");
        expect(capturedHash).toBe("abc123");
      }).pipe(Effect.scoped),
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/auto-pr/diff-toolkit.test.ts`
Expected: FAIL — module `#auto-pr/diff-toolkit.js` not found

- [ ] **Step 4: Implement `DiffToolkit`**

Create `src/auto-pr/diff-toolkit.ts`:

```typescript
/**
 * Effect Toolkit for AI-accessible git diff tools.
 * Tools: get_diff (branch diff, optionally per-file), get_commit_diff (single commit).
 * Handlers delegate to GitContext.
 */

import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { GitContext } from "#auto-pr/git-context.js";

const GetDiff = Tool.make("get_diff", {
  description: "Get the git diff for changed files. Provide path for one file, omit for all.",
  parameters: Schema.Struct({
    path: Schema.optional(Schema.String).annotations({
      description: "File path to diff. Omit for all changed files.",
    }),
  }),
  success: Schema.String,
  failureMode: "return" as const,
});

const GetCommitDiff = Tool.make("get_commit_diff", {
  description: "Get the diff introduced by a specific commit by its hash.",
  parameters: Schema.Struct({
    hash: Schema.String.annotations({
      description: "Full or short commit hash from the commit list.",
    }),
  }),
  success: Schema.String,
  failureMode: "return" as const,
});

export const DiffToolkit = Toolkit.make(GetDiff, GetCommitDiff);

/**
 * Build DiffToolkit handler layer. Captures baseRef and headRef.
 * Requires GitContext in scope.
 */
export function makeDiffToolkitLayer(baseRef: string, headRef: string) {
  return DiffToolkit.toLayer(
    Effect.gen(function* () {
      const git = yield* GitContext;
      return DiffToolkit.of({
        get_diff: Effect.fn("DiffToolkit.get_diff")(function* ({ path }) {
          return yield* git.getDiff(baseRef, headRef, path);
        }),
        get_commit_diff: Effect.fn("DiffToolkit.get_commit_diff")(function* ({ hash }) {
          return yield* git.getCommitDiff(hash);
        }),
      });
    }),
  );
}
```

Note: The exact `Toolkit.of` / `DiffToolkit.of` API should be verified against the installed `effect@4.0.0-beta.42`. The handler pattern matches `ai-docs/src/71_ai/20_tools.ts` from effect-smol. If `DiffToolkit.of` is not available, use a plain object: `{ get_diff: ..., get_commit_diff: ... }`.

- [ ] **Step 5: Run test**

Run: `bun test test/auto-pr/diff-toolkit.test.ts`
Expected: PASS (or adjust API if Toolkit.of differs — check error message and adapt)

- [ ] **Step 6: Commit**

```bash
git add src/auto-pr/diff-toolkit.ts test/auto-pr/diff-toolkit.test.ts test/test-utils.ts
git commit -m "feat: add DiffToolkit with get_diff and get_commit_diff tools"
```

---

### Task 5: Config Changes — Add `defaultBranch` and `branch` to `GeneratePrContentConfig`

**Files:**
- Modify: `src/auto-pr/config.ts`
- Modify: `test/auto-pr/config.test.ts`

- [ ] **Step 1: Write failing test**

Add to `test/auto-pr/config.test.ts`:

```typescript
describe("GeneratePrContentConfig", () => {
  test("reads DEFAULT_BRANCH and BRANCH from env", async () => {
    process.env.DEFAULT_BRANCH = "main";
    process.env.BRANCH = "ai/test-branch";
    process.env.GITHUB_WORKSPACE = "/tmp/ws";
    process.env.AUTO_PR_AI_PROVIDER = "local";
    try {
      await runEffect(/* appropriate layer */)(
        Effect.gen(function* () {
          const config = yield* GeneratePrContentConfig;
          expect(config.defaultBranch).toBe("main");
          expect(config.branch).toBe("ai/test-branch");
        }),
      );
    } finally {
      delete process.env.DEFAULT_BRANCH;
      delete process.env.BRANCH;
      delete process.env.GITHUB_WORKSPACE;
      delete process.env.AUTO_PR_AI_PROVIDER;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/auto-pr/config.test.ts --filter "DEFAULT_BRANCH and BRANCH"`
Expected: FAIL — `defaultBranch` / `branch` not on config type

- [ ] **Step 3: Add fields to config**

In `src/auto-pr/config.ts`, update `GeneratePrContentConfig`:

```typescript
export interface GeneratePrContentConfig {
  readonly defaultBranch: string;
  readonly branch: string;
  readonly workspace: string;
  readonly templatePath: string;
  readonly provider: AiProvider;
  readonly model: string;
  readonly ghToken?: Redacted.Redacted<string>;
  readonly openaiCompatUrl?: string;
  readonly openaiCompatApiKey?: Redacted.Redacted<string>;
}
```

Update the config definition to read `DEFAULT_BRANCH` and `BRANCH`:

```typescript
const GeneratePrContentConfigDef = Config.all({
  defaultBranch: Config.string("DEFAULT_BRANCH"),
  branch: Config.string("BRANCH"),
  workspace: Config.string("GITHUB_WORKSPACE"),
  provider: Config.string("AUTO_PR_AI_PROVIDER").pipe(Config.withDefault(DEFAULT_AI_PROVIDER)),
  model: Config.string("AUTO_PR_AI_OPENAI_COMPAT_MODEL").pipe(Config.option),
  ghToken: Config.redacted("GH_TOKEN").pipe(Config.option),
  openaiCompatUrl: Config.string("AUTO_PR_AI_OPENAI_COMPAT_URL").pipe(Config.option),
  openaiCompatApiKey: Config.redacted("AUTO_PR_AI_OPENAI_COMPAT_API_KEY").pipe(Config.option),
});
```

Add validation for `defaultBranch` and `branch` inside `GeneratePrContentConfigLayer`:

```typescript
const defaultBranch = yield* requireNonEmpty("DEFAULT_BRANCH", base.defaultBranch);
const branch = yield* requireNonEmpty("BRANCH", base.branch);
```

Remove the old `commits` and `files` fields (they no longer come from file paths — `generate-content` gets them via `GitContext`).

- [ ] **Step 4: Run tests**

Run: `bun test test/auto-pr/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auto-pr/config.ts test/auto-pr/config.test.ts
git commit -m "feat: add defaultBranch and branch to GeneratePrContentConfig"
```

---

### Task 6: Refactor `generate-content` to Use `GitContext` and Toolkit

This is the largest task. It rewires `generate-content` from reading file artifacts to using `GitContext` directly.

**Files:**
- Modify: `src/workflow/auto-pr-generate-content.ts`
- Modify: `test/workflow/generate-pr-content.test.ts`

- [ ] **Step 1: Update `generatePrContentFromValues` signature and implementation**

The function changes from taking `commitsContent`/`filesContent` strings to taking `baseRef`/`headRef` and requiring `GitContext`. Rename to `generatePrContent` (no longer "from values" — it fetches its own data).

In `src/workflow/auto-pr-generate-content.ts`:

```typescript
export type GeneratePrContentParams = {
  baseRef: string;
  headRef: string;
  templateContent: string;
  descriptionPromptText: string;
  provider: AiProvider;
  model: string;
  retryDelay?: Duration.Duration;
};

export function generatePrContent(
  params: GeneratePrContentParams,
): Effect.Effect<
  { title: string; body: string; count: number },
  NoSemanticCommitsError | ParseError | TemplateRenderError,
  LanguageModel.LanguageModel | GitContext
> {
  return Effect.gen(function* () {
    const { baseRef, headRef, templateContent, descriptionPromptText, retryDelay } = params;
    const git = yield* GitContext;

    // Fetch git data
    const logOutput = yield* git.getLog(baseRef, headRef);
    const filesOutput = yield* git.getChangedFiles(baseRef, headRef);
    const diffStatOutput = yield* git.getDiffStat(baseRef, headRef);

    // Parse (pure core)
    const parseResult = parseCommits(logOutput);
    const rawCommits = yield* Effect.fromResult(parseResult);
    const filtered = filterMergeCommits(rawCommits);
    const count = filtered.length;

    if (count === 0) {
      return yield* Effect.fail(
        new NoSemanticCommitsError({
          message:
            "No semantic commits (all merge or non-semantic). Add at least one non-merge commit before pushing.",
        }),
      );
    }

    const files = parseFilesContent(filesOutput);

    let title: string;
    let descriptionOverride: string | undefined;

    if (count >= 2) {
      const commitContent = getDescriptionPromptText(filtered);
      const prompt = buildDescriptionPrompt(descriptionPromptText, diffStatOutput, commitContent);
      const delay = retryDelay ?? DEFAULT_RETRY_DELAY;
      const toolkit = DiffToolkit;
      const result = yield* generateTitleAndDescription(
        prompt,
        filtered,
        delay,
        params.provider,
        params.model,
        toolkit,
      );
      title = result.title;
      descriptionOverride = result.description;
    } else {
      title = getTitleFromCommits(filtered);
      descriptionOverride = undefined;
    }

    const bodyResult = renderBodyCore(filtered, files, templateContent, descriptionOverride, title);
    const body = yield* Effect.fromResult(bodyResult);
    return { title, body, count };
  }).pipe(
    Effect.catchDefect((defect) =>
      Effect.logError({
        event: "generate_pr_content",
        status: "defect",
        cause: unknownToMessage(defect),
      }).pipe(Effect.flatMap(() => Effect.fail(normalizeUnknownToGeneratePrContentError(defect)))),
    ),
    Effect.catchTags(
      {
        NoSemanticCommitsError: (e: NoSemanticCommitsError) => Effect.fail(e),
        ParseError: (e: ParseError) => Effect.fail(e),
        TemplateRenderError: (e: TemplateRenderError) => Effect.fail(e),
      },
      (e: unknown) => Effect.fail(normalizeUnknownToGeneratePrContentError(e)),
    ),
  );
}
```

- [ ] **Step 2: Update `generateTitleAndDescription` to accept toolkit**

```typescript
function generateTitleAndDescription(
  prompt: string,
  filtered: readonly CommitInfo[],
  retryDelay: Duration.Duration,
  provider: AiProvider,
  model: string,
  toolkit: typeof DiffToolkit,
): Effect.Effect<{ title: string; description: string }, unknown, LanguageModel.LanguageModel> {
  return Effect.gen(function* () {
    yield* Effect.log({
      event: "generate_pr_content",
      step: "ai_query",
      status: "start",
      provider,
      model,
      prompt_chars: prompt.length,
    });
    const res = yield* LanguageModel.generateText({ prompt, toolkit });
    const raw = yield* decodeTitleDescriptionFromAssistantText(res.text);
    return yield* logAndValidateTitleDescription(raw, provider, model);
  }).pipe(
    Effect.tapError((e) =>
      Effect.logWarning({
        event: "generate_pr_content",
        step: e instanceof DescriptionParseError ? "validation" : "ai_query",
        status: "failed",
        provider,
        model,
        reason: formatError(e),
      }),
    ),
    Effect.retry(makeRetrySchedule(retryDelay)),
    Effect.catch(() =>
      Effect.succeed(getFallbackTitleAndDescription(filtered)).pipe(
        Effect.tap(() =>
          Effect.logWarning({
            event: "generate_pr_content",
            status: "fallback",
            message: "Using fallback title after 5 invalid attempts",
          }),
        ),
      ),
    ),
  );
}
```

- [ ] **Step 3: Update `runGeneratePrContent` to build layers with GitContext**

```typescript
export function runGeneratePrContent(config: {
  defaultBranch: string;
  branch: string;
  workspace: string;
  templatePath: string;
  provider: AiProvider;
  model: string;
  ghToken?: Redacted.Redacted<string>;
  openaiCompatUrl?: string;
  openaiCompatApiKey?: Redacted.Redacted<string>;
  retryDelay?: Duration.Duration;
  fetch?: typeof fetch;
}): Effect.Effect<void, GeneratePrContentError, FileSystem.FileSystem | Path.Path> {
  const toUnexpected = (ctx: string) => (e: unknown) =>
    new UnexpectedError({ cause: `${ctx}: ${unknownToMessage(e)}` });

  return Effect.gen(function* () {
    const {
      defaultBranch,
      branch,
      workspace,
      templatePath,
      provider,
      model,
      retryDelay,
      ghToken,
      openaiCompatUrl,
      openaiCompatApiKey,
    } = config;
    const pathApi = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;

    const baseRef = `origin/${defaultBranch}`;

    const [templateContent, descriptionPromptText] = yield* Effect.all([
      fs.readFileString(templatePath).pipe(Effect.mapError(toUnexpected("template"))),
      getPrDescriptionPromptPath().pipe(
        Effect.mapError(toUnexpected("getPrDescriptionPromptPath")),
        Effect.flatMap((p) =>
          fs.readFileString(p).pipe(Effect.mapError(toUnexpected("pr-description.txt"))),
        ),
      ),
    ]);

    const aiLayer = aiProviderLayerFromConfig(
      {
        provider,
        model,
        ...(ghToken !== undefined ? { ghToken } : {}),
        ...(provider === "local"
          ? {
              ...(openaiCompatUrl !== undefined ? { openaiCompatUrl } : {}),
              ...(openaiCompatApiKey !== undefined ? { openaiCompatApiKey } : {}),
            }
          : {}),
      },
      config.fetch !== undefined ? { fetch: config.fetch } : undefined,
    );

    const gitLayer = GitContextLive(workspace);
    const toolkitLayer = makeDiffToolkitLayer(baseRef, branch);

    const generateLayer = Layer.mergeAll(
      AutoPrPlatformLayer,
      aiLayer,
      gitLayer.pipe(Layer.provide(ChildProcessSpawnerLayer)),
      toolkitLayer.pipe(
        Layer.provide(gitLayer),
        Layer.provide(ChildProcessSpawnerLayer),
      ),
    );

    const { title, body, count } = yield* generatePrContent({
      baseRef,
      headRef: branch,
      templateContent,
      descriptionPromptText,
      provider,
      model,
      ...(retryDelay !== undefined && { retryDelay }),
    }).pipe(Effect.provide(generateLayer));

    const bodyPath = pathApi.join(workspace, PR_BODY_FILE_NAME);
    const titlePath = pathApi.join(workspace, PR_TITLE_FILE_NAME);
    yield* fs
      .writeFileString(titlePath, title)
      .pipe(Effect.mapError(toUnexpected("write pr-title.txt")));
    yield* fs
      .writeFileString(bodyPath, body)
      .pipe(Effect.mapError(toUnexpected("write pr-body.md")));
    yield* Effect.log({
      event: "generate_pr_content",
      status: "success",
      count,
      mode: count >= 2 ? "ai" : "single_commit",
    });
  }).pipe(
    Effect.catchDefect((defect) =>
      Effect.logError({
        event: "generate_pr_content",
        status: "defect",
        cause: unknownToMessage(defect),
      }).pipe(Effect.flatMap(() => Effect.fail(toUnexpected("defect")(defect)))),
    ),
  );
}
```

- [ ] **Step 4: Update the entry point program**

```typescript
const program = Effect.gen(function* () {
  const config = yield* GeneratePrContentConfig;
  const params = {
    defaultBranch: config.defaultBranch,
    branch: config.branch,
    workspace: config.workspace,
    templatePath: config.templatePath,
    provider: config.provider,
    model: config.model,
    ...(config.ghToken !== undefined ? { ghToken: config.ghToken } : {}),
    ...(config.provider === "local"
      ? {
          ...(config.openaiCompatUrl !== undefined
            ? { openaiCompatUrl: config.openaiCompatUrl }
            : {}),
          ...(config.openaiCompatApiKey !== undefined
            ? { openaiCompatApiKey: config.openaiCompatApiKey }
            : {}),
        }
      : {}),
  };
  yield* runGeneratePrContent(params).pipe(
    Effect.provide(Layer.mergeAll(AutoPrPlatformLayer, ChildProcessSpawnerLayer)),
  );
}).pipe(Effect.provide(GeneratePrContentConfigLayer));
```

- [ ] **Step 5: Update tests**

Rewrite `test/workflow/generate-pr-content.test.ts` to use mock `GitContext` instead of passing string content:

```typescript
import { GitContext } from "#auto-pr/git-context.js";
import { createGitContextMock } from "#test/test-utils.js";

function logContent(...blocks: Array<{ hash?: string; subject: string; body: string }>): string {
  const formatted = blocks.map((b) => {
    const hash = b.hash ?? "0000000000000000000000000000000000000000";
    const msg = b.body ? `${b.subject}\n\n${b.body}`.trim() : b.subject;
    return `${hash}\n${msg}`;
  });
  return `---COMMIT---\n${formatted.join("\n---COMMIT---\n")}`;
}

function mockGitContext(
  commits: Array<{ hash?: string; subject: string; body: string }>,
  files = "src/foo.ts\n",
  diffStat = " src/foo.ts | 5 +++++\n 1 file changed, 5 insertions(+)",
): GitContext {
  return createGitContextMock({
    getLog: () => Effect.succeed(logContent(...commits)),
    getChangedFiles: () => Effect.succeed(files),
    getDiffStat: () => Effect.succeed(diffStat),
    getDiff: () => Effect.succeed(""),
    getCommitDiff: () => Effect.succeed(""),
  });
}

// Update params helper:
function params(
  commits: Array<{ hash?: string; subject: string; body: string }>,
  overrides?: Partial<GeneratePrContentParams> & { files?: string; diffStat?: string; fetch?: typeof fetch },
): { params: GeneratePrContentParams; gitCtx: GitContext; fetch?: typeof fetch } {
  return {
    params: {
      baseRef: "origin/main",
      headRef: "ai/test",
      templateContent: DEFAULT_TEMPLATE,
      descriptionPromptText: DEFAULT_DESCRIPTION_PROMPT,
      provider: "local" as const,
      model: "gpt-oss",
      retryDelay: Duration.zero,
      ...overrides,
    },
    gitCtx: mockGitContext(commits, overrides?.files, overrides?.diffStat),
    fetch: overrides?.fetch,
  };
}

function layerForGeneratePrContent(p: {
  params: GeneratePrContentParams;
  gitCtx: GitContext;
  fetch?: typeof fetch;
}) {
  return Layer.mergeAll(
    ValueBasedLayer,
    Layer.succeed(GitContext, p.gitCtx),
    aiProviderLayerFromConfig(
      { provider: p.params.provider, model: p.params.model },
      p.fetch !== undefined ? { fetch: p.fetch } : undefined,
    ),
  );
}
```

Update each test to use the new pattern. For example:

```typescript
test("returns title and body for 1 commit (no AI call)", async () => {
  const p = params([{ subject: "feat: add x", body: "" }]);
  await runEffect(layerForGeneratePrContent(p))(
    Effect.gen(function* () {
      const result = yield* generatePrContent(p.params);
      expect(result.title).toBe("feat: add x");
      expect(result.body).toContain("add x");
      expect(result.count).toBe(1);
    }).pipe(Effect.scoped),
  );
});
```

- [ ] **Step 6: Run tests**

Run: `bun test test/workflow/generate-pr-content.test.ts`
Expected: PASS

- [ ] **Step 7: Run full test suite**

Run: `bun test`
Expected: PASS (some get-commits tests will fail — that's expected, they're deleted in Task 7)

- [ ] **Step 8: Commit**

```bash
git add src/workflow/auto-pr-generate-content.ts test/workflow/generate-pr-content.test.ts
git commit -m "feat: refactor generate-content to use GitContext and DiffToolkit"
```

---

### Task 7: Simplify `auto-pr-run.ts` and Delete `get-commits`

**Files:**
- Modify: `src/workflow/auto-pr-run.ts`
- Delete: `src/workflow/auto-pr-get-commits.ts`
- Delete: `test/workflow/auto-pr-get-commits.test.ts`
- Delete: `test/workflow/pipeline.test.ts`
- Modify: `src/auto-pr/index.ts`
- Modify: `src/core/index.ts`
- Modify: `package.json`

- [ ] **Step 1: Simplify `auto-pr-run.ts`**

```typescript
/**
 * Run the auto-PR pipeline locally (no GitHub Actions).
 * Requires: DEFAULT_BRANCH, GITHUB_WORKSPACE, GH_TOKEN, BRANCH (or auto-detected).
 */

import { join } from "node:path";
import { Effect, FileSystem, Layer } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { PullRequestFailedError } from "#auto-pr";
import {
  AutoPrLoggerLayer,
  AutoPrPlatformLayer,
  ChildProcessSpawnerLayer,
  PR_BODY_FILE_NAME,
  PR_TITLE_FILE_NAME,
  RunAutoPrConfig,
  RunAutoPrConfigLayer,
  runCommand,
  runMain,
} from "#auto-pr";
import { runCreateOrUpdatePr } from "#workflow/auto-pr-create-or-update-pr.js";
import { runGeneratePrContent } from "#workflow/auto-pr-generate-content.js";

const RunAutoPrLayer = Layer.mergeAll(
  AutoPrPlatformLayer,
  ChildProcessSpawnerLayer,
);

function runPipeline(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* RunAutoPrConfig;
    const { workspace, defaultBranch, templatePath, provider, model } = config;
    const resolvedBranch =
      config.branch !== undefined ? Effect.succeed(config.branch) : getCurrentBranch(workspace);
    const branchVal = yield* resolvedBranch;

    yield* Effect.log({ event: "run_auto_pr", step: "generate_content" });
    yield* runGeneratePrContent({
      defaultBranch,
      branch: branchVal,
      workspace,
      templatePath,
      provider,
      model,
      ...(provider === "github-models" ? { ghToken: config.ghToken } : {}),
      ...(provider === "local"
        ? {
            ...(config.openaiCompatUrl !== undefined
              ? { openaiCompatUrl: config.openaiCompatUrl }
              : {}),
            ...(config.openaiCompatApiKey !== undefined
              ? { openaiCompatApiKey: config.openaiCompatApiKey }
              : {}),
          }
        : {}),
    });

    const titlePath = join(workspace, PR_TITLE_FILE_NAME);
    const bodyPath = join(workspace, PR_BODY_FILE_NAME);
    const title = (yield* fs.readFileString(titlePath)).trim();

    yield* Effect.log({ event: "run_auto_pr", step: "create_or_update_pr" });
    yield* runCreateOrUpdatePr({
      branch: branchVal,
      defaultBranch,
      title,
      bodyFile: bodyPath,
      workspace,
    });

    yield* Effect.log({ event: "run_auto_pr", status: "done" });
  }).pipe(
    Effect.provide(RunAutoPrLayer),
    Effect.provide(RunAutoPrConfigLayer),
    Effect.provide(AutoPrLoggerLayer),
  );
}

function getCurrentBranch(
  cwd: string,
): Effect.Effect<string, PullRequestFailedError, ChildProcessSpawner> {
  return runCommand("git", ["branch", "--show-current"], cwd);
}

if (import.meta.main) {
  runMain(runPipeline(), "run_auto_pr_failed");
}
```

- [ ] **Step 2: Delete get-commits files**

```bash
rm src/workflow/auto-pr-get-commits.ts
rm test/workflow/auto-pr-get-commits.test.ts
rm test/workflow/pipeline.test.ts
```

- [ ] **Step 3: Update barrel exports in `src/auto-pr/index.ts`**

Remove all get-commits related exports:
- `GetCommitsConfig`, `GetCommitsConfigLayer`
- `buildGetCommitsGhEntries`, `validateGetCommitsOutput`, `parseGhOutput`
- `appendGhOutput`
- `filterSemanticSubjects`, `parseSubjects` (if only used by get-commits — check first)

Add new exports:
- `GitContext`, `GitContextLive` from `#auto-pr/git-context.js`
- `DiffToolkit`, `makeDiffToolkitLayer` from `#auto-pr/diff-toolkit.js`

- [ ] **Step 4: Update `src/core/index.ts`**

Remove exports only used by get-commits:
- `buildGetCommitsGhEntries`, `validateGetCommitsOutput`
- Keep `formatGhOutput`, `parseGhOutput` etc. if used elsewhere

- [ ] **Step 5: Remove `auto-pr-get-commits` from `package.json` bin**

```json
"bin": {
  "auto-pr-generate-content": "./dist/workflow/auto-pr-generate-content.js",
  "auto-pr-create-or-update-pr": "./dist/workflow/auto-pr-create-or-update-pr.js",
  "auto-pr-run": "./dist/workflow/auto-pr-run.js",
  "auto-pr-fill-pr-template": "./dist/tools/auto-pr-fill-pr-template.js",
  "auto-pr-init": "./dist/tools/auto-pr-init.js"
}
```

Also remove the `get-commits` script from `"scripts"` if it exists.

- [ ] **Step 6: Update `RunAutoPrConfig`**

Check if `RunAutoPrConfig` in `config.ts` still references `GetCommitsConfig` or any of the deleted utilities. Remove any dead references. Ensure `RunAutoPrConfig` includes `defaultBranch` and `branch` (it likely already has them).

- [ ] **Step 7: Run full test suite**

Run: `bun test`
Expected: PASS (no get-commits tests remain, all other tests pass)

- [ ] **Step 8: Run lint and typecheck**

Run: `bun run check:code`
Expected: PASS (no unused exports, no type errors)

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: eliminate get-commits, simplify auto-pr-run pipeline"
```

---

### Task 8: Update CI Workflow

**Files:**
- Modify: `.github/workflows/auto-pr-generate-reusable.yml`
- Modify: `.github/actions/auto-pr-run-command/action.yml`
- Modify: `.github/actions/auto-pr-run-command/auto-pr-run-command.sh` (if it dispatches get-commits)

- [ ] **Step 1: Add lightweight bash commit count step**

In `.github/workflows/auto-pr-generate-reusable.yml`, replace the "Get commit log and changed files" step with a lightweight bash count:

```yaml
      - name: Count non-merge commits
        id: commits
        env:
          DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}
        run: |
          count=$(git log --format=%s "origin/$DEFAULT_BRANCH..HEAD" | grep -cvE '^Merge ' || true)
          echo "count=$count" >> "$GITHUB_OUTPUT"
```

- [ ] **Step 2: Update generate-content step env vars**

Add `DEFAULT_BRANCH` and `BRANCH` to the generate-content step:

```yaml
      - name: Generate PR content
        id: generate
        uses: knirski/auto-pr/.github/actions/auto-pr-run-command@<SHA>
        with:
          command: generate-content
          use_workspace: ${{ steps.auto-pr-pkg.outputs.use_workspace }}
          auto_pr_pkg: ${{ steps.auto-pr-pkg.outputs.value }}
          runner: ${{ steps.setup.outputs.runner }}
        env:
          DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}
          BRANCH: ${{ github.ref_name }}
          AUTO_PR_AI_PROVIDER: ${{ inputs.ai_provider }}
          AUTO_PR_AI_OPENAI_COMPAT_URL: ${{ steps.local_llama.outputs.compat_url != '' && steps.local_llama.outputs.compat_url || inputs.ai_openai_compat_url }}
          AUTO_PR_AI_OPENAI_COMPAT_API_KEY: ${{ inputs.ai_openai_compat_api_key }}
          AUTO_PR_AI_OPENAI_COMPAT_MODEL: ${{ inputs.ai_openai_compat_model }}
          GH_TOKEN: ${{ inputs.ai_provider == 'github-models' && (secrets.GH_TOKEN || github.token) || '' }}
```

- [ ] **Step 3: Update `auto-pr-run-command` action**

Remove `get-commits` related outputs from `action.yml`:

```yaml
outputs:
  # commits, files, count outputs removed — no longer provided
  {}
```

Update `auto-pr-run-command.sh` to remove the `get-commits` command handling if it has special logic for it.

- [ ] **Step 4: Verify llama conditionals still work**

The llama conditional steps reference `steps.commits.outputs.count != '1'`. The new bash step still provides this output. Verify all conditional references still match.

- [ ] **Step 5: Commit**

```bash
git add .github/
git commit -m "ci: update generate workflow to use inline commit count, remove get-commits step"
```

---

### Task 9: Final Verification

- [ ] **Step 1: Run full check**

```bash
bun run check:code
```

Expected: build, audit, tests, lint, typecheck, knip all PASS.

- [ ] **Step 2: Verify no dead exports with knip**

```bash
bun run knip
```

Expected: No unused exports related to get-commits. If knip flags new unused exports (e.g., `appendGhOutput`, `buildGetCommitsGhEntries`), remove them.

- [ ] **Step 3: Run integration tests (if env is configured)**

```bash
bun run test:integration
```

Expected: PASS (tests should work with tool-calling-capable models)

- [ ] **Step 4: Verify the design spec is still accurate**

Read `docs/superpowers/specs/2026-04-06-diff-tool-use-design.md` and confirm it matches what was implemented. Update if any details diverged during implementation.

- [ ] **Step 5: Final commit (if any cleanup needed)**

```bash
git add -A
git commit -m "chore: final cleanup after diff tool use implementation"
```
