# Error Handling, Observability & Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve auto-pr's error handling, observability, and resilience across two thematic PRs: PR 1 adds narrowed AI error handling, branch validation, structured tool errors, visible config defaults, tool use logging, and token usage logging; PR 2 adds git command timeouts and diff size limits.

**Architecture:** PR 1 focuses on `src/auto-pr/errors.ts`, `src/auto-pr/config.ts`, `src/auto-pr/diff-toolkit.ts`, and `src/workflow/auto-pr-generate-content.ts`. PR 2 focuses on `src/auto-pr/git-context.ts` and a new `src/core/sanitize-diff.ts`. All changes are TDD: write the failing test first, implement minimally to pass, then commit.

**Tech Stack:** TypeScript, Effect v4 (effect-smol), bun:test, `Effect.catchIf`, `Effect.timeout`, `Duration`, `Logger`

---

## PR 1: Error Handling & Observability

### Task 1: Add `isTransientAiError` helper

**Files:**
- Modify: `src/auto-pr/errors.ts` — add exported `isTransientAiError(e: unknown): boolean`
- Modify: `src/auto-pr/index.ts` — re-export `isTransientAiError`
- Modify: `test/auto-pr/errors.test.ts` — add tests for `isTransientAiError`

- [ ] **Step 1: Write failing tests for `isTransientAiError`**

Add to the end of `test/auto-pr/errors.test.ts`:

```typescript
import { isTransientAiError } from "#auto-pr/errors.js";

test("isTransientAiError returns true for DescriptionParseError", () => {
  expect(isTransientAiError(new DescriptionParseError({ cause: "parse failed" }))).toBe(true);
});

test("isTransientAiError returns true for AiProviderError with 429", () => {
  expect(isTransientAiError(new AiProviderError({ status: 429, cause: "rate limited" }))).toBe(true);
});

test("isTransientAiError returns true for AiProviderError with 500", () => {
  expect(isTransientAiError(new AiProviderError({ status: 500, cause: "server error" }))).toBe(true);
});

test("isTransientAiError returns true for AiProviderError with 503", () => {
  expect(isTransientAiError(new AiProviderError({ status: 503, cause: "unavailable" }))).toBe(true);
});

test("isTransientAiError returns true for AiProviderError with null status (network error)", () => {
  expect(isTransientAiError(new AiProviderError({ cause: "connection refused" }))).toBe(true);
});

test("isTransientAiError returns false for AiProviderError with 401", () => {
  expect(isTransientAiError(new AiProviderError({ status: 401, cause: "unauthorized" }))).toBe(false);
});

test("isTransientAiError returns false for AiProviderError with 403", () => {
  expect(isTransientAiError(new AiProviderError({ status: 403, cause: "forbidden" }))).toBe(false);
});

test("isTransientAiError returns true for unknown/generic errors", () => {
  expect(isTransientAiError(new Error("schema decode failed"))).toBe(true);
  expect(isTransientAiError("some string error")).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test test/auto-pr/errors.test.ts
```

Expected: `ReferenceError: isTransientAiError is not defined` or similar import error.

- [ ] **Step 3: Implement `isTransientAiError` in `src/auto-pr/errors.ts`**

Add at the end of `src/auto-pr/errors.ts` (after the existing `formatError` function):

```typescript
/**
 * Returns true if the error is transient (network, rate limit, 5xx, parse/validation failures)
 * and the caller should fall back to a commit-summary PR.
 * Returns false for config/auth errors (401/403) that indicate bad configuration.
 */
export function isTransientAiError(e: unknown): boolean {
  if (e instanceof DescriptionParseError) return true;
  if (e instanceof AiProviderError) {
    const { status } = e;
    if (status == null) return true; // network / connection error
    if (status === 429 || status >= 500) return true; // rate limit or server error
    return false; // 401, 403 = config / auth error
  }
  return true; // schema decode failures and other unknown errors are transient
}
```

- [ ] **Step 4: Re-export from `src/auto-pr/index.ts`**

Add `isTransientAiError` to the existing export from `#auto-pr/errors.js` in `src/auto-pr/index.ts`:

```typescript
export {
  ActLocalCiError,
  AiProviderError,
  AutoPrConfigError,
  BodyFileNotFoundError,
  DescriptionParseError,
  FillPrTemplateValidationError,
  formatError,
  isTransientAiError,
  NoSemanticCommitsError,
  ParseError,
  PullRequestBodyBlankError,
  PullRequestFailedError,
  PullRequestTitleBlankError,
  TemplateRenderError,
  UnexpectedError,
} from "#auto-pr/errors.js";
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test test/auto-pr/errors.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/auto-pr/errors.ts src/auto-pr/index.ts test/auto-pr/errors.test.ts
git commit -m "feat(errors): add isTransientAiError helper to distinguish config vs transient AI failures"
```

---

### Task 2: Narrow the AI fallback catch to transient errors only

**Files:**
- Modify: `src/workflow/auto-pr-generate-content.ts` — replace `Effect.catch` with `Effect.catchIf(isTransientAiError, ...)`, add `AiProviderError` handler in `catchTags`
- Modify: `test/workflow/generate-pr-content.test.ts` — add test that auth errors propagate (not fall back)

- [ ] **Step 1: Write failing test for auth error propagation**

In `test/workflow/generate-pr-content.test.ts`, add a new `describe` block after the existing "HTTP 500 from OpenAI-compat endpoint" describe block:

```typescript
describe("HTTP 401 from OpenAI-compat endpoint (auth failure)", () => {
  test("propagates as AutoPrConfigError (does not fall back) when local endpoint returns HTTP 401", async () => {
    const p = makeParams(twoCommits, {
      retryDelay: Duration.zero,
      fetch: createOpenAiChatCompletionsMockFetch({
        content: VALID_AI_RESPONSE,
        status: 401,
      }),
    });
    await runEffect(layerForTest(p))(
      Effect.gen(function* () {
        const exit = yield* generatePrContent(p.params).pipe(Effect.exit, Effect.scoped);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          Result.match(Cause.findError(exit.cause), {
            onSuccess: (err) => {
              expect(err).toBeInstanceOf(AutoPrConfigError);
              expect((err as AutoPrConfigError).missing.join(" ")).toContain("401");
            },
            onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
          });
        }
      }).pipe(Effect.scoped),
    );
  });

  test("propagates as AutoPrConfigError when local endpoint returns HTTP 403", async () => {
    const p = makeParams(twoCommits, {
      retryDelay: Duration.zero,
      fetch: createOpenAiChatCompletionsMockFetch({
        content: VALID_AI_RESPONSE,
        status: 403,
      }),
    });
    await runEffect(layerForTest(p))(
      Effect.gen(function* () {
        const exit = yield* generatePrContent(p.params).pipe(Effect.exit, Effect.scoped);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          Result.match(Cause.findError(exit.cause), {
            onSuccess: (err) => {
              expect(err).toBeInstanceOf(AutoPrConfigError);
            },
            onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
          });
        }
      }).pipe(Effect.scoped),
    );
  });
});
```

Also add `AutoPrConfigError` to the import from `#auto-pr`:
```typescript
import {
  aiProviderLayerFromConfig,
  AutoPrConfigError,
  ChildProcessSpawnerLayer,
  DiffToolkit,
  NoSemanticCommitsError,
  ParseError,
  TemplateRenderError,
} from "#auto-pr";
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test test/workflow/generate-pr-content.test.ts 2>&1 | grep -A3 "HTTP 401"
```

Expected: tests fail because HTTP 401 currently falls back to commit-summary instead of failing.

- [ ] **Step 3: Replace `Effect.catch` with `Effect.catchIf` in `generateTitleAndDescriptionWithToolkit`**

In `src/workflow/auto-pr-generate-content.ts`, change the `.pipe` at the end of `generateTitleAndDescriptionWithToolkit` (around line 287–298). Also add `isTransientAiError` to imports from `#auto-pr`.

Import change — add `isTransientAiError` to the `#auto-pr` import:
```typescript
import {
  type AiProvider,
  type AutoPrConfigError,
  AutoPrPlatformLayer,
  aiProviderLayerFromConfig,
  buildDescriptionPrompt,
  ChildProcessSpawnerLayer,
  DescriptionParseError,
  DiffToolkit,
  formatError,
  GeneratePrContentConfig,
  GeneratePrContentConfigLayer,
  GitContext,
  GitContextLive,
  getPrDescriptionPromptPath,
  isBlank,
  isTransientAiError,
  makeDiffToolkitLayer,
  NoSemanticCommitsError,
  ParseError,
  PR_BODY_FILE_NAME,
  PR_TITLE_FILE_NAME,
  runMain,
  TemplateRenderError,
  toError,
  UnexpectedError,
  unknownToMessage,
} from "#auto-pr";
```

Replace the `Effect.catch` call with `Effect.catchIf`:
```typescript
    Effect.catchIf(
      isTransientAiError,
      () =>
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
```

- [ ] **Step 4: Add `AiProviderError` handler in `generatePrContent`'s `catchTags`**

In `generatePrContent`, the `.pipe` at the end uses `Effect.catchTags`. Add `AiProviderError` to convert non-transient provider errors to `AutoPrConfigError`. Also import `AiProviderError` from `#auto-pr`.

Add `AiProviderError` to the `#auto-pr` import (add to existing).

Change the `Effect.catchTags` call in `generatePrContent` to:
```typescript
    Effect.catchTags(
      {
        NoSemanticCommitsError: (e: NoSemanticCommitsError) => Effect.fail(e),
        ParseError: (e: ParseError) => Effect.fail(e),
        TemplateRenderError: (e: TemplateRenderError) => Effect.fail(e),
        AiProviderError: (e) =>
          Effect.fail(
            new AutoPrConfigError({
              missing: [
                `AI provider authentication/config error (HTTP ${e.status ?? "unknown"}): ${e.cause}. Check AUTO_PR_AI_OPENAI_COMPAT_URL and credentials.`,
              ],
            }),
          ),
      },
      (e: unknown) => Effect.fail(normalizeUnknownToGeneratePrContentError(e)),
    ),
```

Also update the `GeneratePrContentErrorSchema` to include `AiProviderError` handling (the schema union doesn't need to change since we catch it at `catchTags`; `AutoPrConfigError` is already in `GeneratePrContentError` type).

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test test/workflow/generate-pr-content.test.ts
```

Expected: all tests PASS, including the new 401/403 tests.

- [ ] **Step 6: Run full test suite**

```bash
bun test
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/workflow/auto-pr-generate-content.ts test/workflow/generate-pr-content.test.ts
git commit -m "feat(generate-content): narrow AI fallback to transient errors; propagate 401/403 as AutoPrConfigError"
```

---

### Task 3: Branch self-reference validation

**Files:**
- Modify: `src/auto-pr/config.ts` — add guard in `GeneratePrContentConfigLayer` and `RunAutoPrConfigLayer`
- Modify: `test/auto-pr/config.test.ts` — add tests for `branch === defaultBranch` rejection

- [ ] **Step 1: Write failing tests**

Add a new describe block to `test/auto-pr/config.test.ts`:

```typescript
describe("GeneratePrContentConfigLayer rejects branch === defaultBranch", () => {
  test("fails when BRANCH equals DEFAULT_BRANCH", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        GITHUB_WORKSPACE: "/workspace",
        DEFAULT_BRANCH: "main",
        BRANCH: "main",
        AUTO_PR_AI_OPENAI_COMPAT_MODEL: "gpt-oss",
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* GeneratePrContentConfig;
      })
        .pipe(Effect.provide(layer))
        .pipe(Effect.exit),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      Result.match(Cause.findError(exit.cause), {
        onSuccess: (err) => {
          expect(err).toBeInstanceOf(AutoPrConfigError);
          expect((err as AutoPrConfigError).missing.join(" ")).toContain("BRANCH");
          expect((err as AutoPrConfigError).missing.join(" ")).toContain("DEFAULT_BRANCH");
        },
        onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
      });
    }
  });
});

describe("RunAutoPrConfigLayer rejects branch === defaultBranch when BRANCH is set", () => {
  test("fails when BRANCH equals DEFAULT_BRANCH", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...runAutoPrBaseEnv,
        BRANCH: "main",
        AUTO_PR_AI_OPENAI_COMPAT_MODEL: "gpt-oss",
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      RunAutoPrConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* RunAutoPrConfig;
      })
        .pipe(Effect.provide(layer))
        .pipe(Effect.exit),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      Result.match(Cause.findError(exit.cause), {
        onSuccess: (err) => {
          expect(err).toBeInstanceOf(AutoPrConfigError);
          expect((err as AutoPrConfigError).missing.join(" ")).toContain("BRANCH");
        },
        onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
      });
    }
  });

  test("succeeds when BRANCH is not set (optional in RunAutoPr)", async () => {
    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...runAutoPrBaseEnv,
        AUTO_PR_AI_OPENAI_COMPAT_MODEL: "gpt-oss",
        // No BRANCH set
      }),
    );
    const layer = Layer.mergeAll(
      TestBaseLayer,
      RunAutoPrConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        const config = yield* RunAutoPrConfig;
        expect(config.branch).toBeUndefined();
      }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test test/auto-pr/config.test.ts 2>&1 | grep -A3 "rejects branch"
```

Expected: the two "fails when BRANCH equals DEFAULT_BRANCH" tests fail because there's no guard yet.

- [ ] **Step 3: Add branch self-reference guard in `GeneratePrContentConfigLayer`**

In `src/auto-pr/config.ts`, inside `GeneratePrContentConfigLayer`, after `const branch = yield* requireNonEmpty("BRANCH", base.branch);` and `const defaultBranch = yield* requireNonEmpty(...)`, add:

```typescript
if (branch === defaultBranch) {
  return yield* Effect.fail(
    new AutoPrConfigError({
      missing: [`BRANCH (${branch}) must differ from DEFAULT_BRANCH (${defaultBranch})`],
    }),
  );
}
```

Place this right after both `branch` and `defaultBranch` are defined (before `const templatePath = ...`).

- [ ] **Step 4: Add branch self-reference guard in `RunAutoPrConfigLayer`**

In `src/auto-pr/config.ts`, inside `RunAutoPrConfigLayer`, after `const defaultBranch = yield* requireNonEmpty(...)` and `const workspace = yield* requireNonEmpty(...)`. The `branch` in `RunAutoPrConfig` is optional, so we guard only when it's defined.

After the `shared` object is built (it has `branch: Option.getOrUndefined(base.branch)`), add:

```typescript
const resolvedBranch = Option.getOrUndefined(base.branch);
if (resolvedBranch !== undefined && resolvedBranch === defaultBranch) {
  return yield* Effect.fail(
    new AutoPrConfigError({
      missing: [`BRANCH (${resolvedBranch}) must differ from DEFAULT_BRANCH (${defaultBranch})`],
    }),
  );
}
```

Place this before the `Match.value(provider)` block in `RunAutoPrConfigLayer`. Also update `shared` to use `resolvedBranch` instead of `Option.getOrUndefined(base.branch)` directly:

```typescript
const shared = {
  defaultBranch,
  workspace,
  templatePath,
  ghToken: base.ghToken,
  provider,
  branch: resolvedBranch,
};
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test test/auto-pr/config.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/auto-pr/config.ts test/auto-pr/config.test.ts
git commit -m "feat(config): reject branch === defaultBranch to prevent meaningless git diff"
```

---

### Task 4: Structured diff toolkit error responses

**Files:**
- Modify: `src/auto-pr/diff-toolkit.ts` — update error formatting to use `[TOOL_ERROR]` prefix
- Modify: `test/auto-pr/diff-toolkit.test.ts` — add tests for error response format

- [ ] **Step 1: Write failing tests for error response format**

Add to `test/auto-pr/diff-toolkit.test.ts`:

```typescript
describe("DiffToolkit error responses", () => {
  test("get_diff handler returns [TOOL_ERROR] prefixed message on error", async () => {
    const mockGitCtx = createGitContextMock({
      getDiff: () => Effect.fail(new Error("git failed: no such ref")),
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
        const toolkit = yield* DiffToolkit;
        const stream = yield* toolkit.handle("get_diff", { path: "foo.ts" });
        const last = yield* Stream.runLast(stream);
        const handlerResult = Option.getOrThrow(last);
        const result = String(handlerResult.result);
        expect(result).toContain("[TOOL_ERROR]");
        expect(result).toContain("get_diff failed");
        expect(result).toContain("git failed: no such ref");
        expect(result).toContain("No diff available for this request.");
      }).pipe(Effect.scoped),
    );
  });

  test("get_commit_diff handler returns [TOOL_ERROR] prefixed message on error", async () => {
    const mockGitCtx = createGitContextMock({
      getCommitDiff: () => Effect.fail(new Error("unknown commit")),
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
        const toolkit = yield* DiffToolkit;
        const stream = yield* toolkit.handle("get_commit_diff", { hash: "abc123" });
        const last = yield* Stream.runLast(stream);
        const handlerResult = Option.getOrThrow(last);
        const result = String(handlerResult.result);
        expect(result).toContain("[TOOL_ERROR]");
        expect(result).toContain("get_commit_diff failed");
        expect(result).toContain("unknown commit");
        expect(result).toContain("No diff available for this request.");
      }).pipe(Effect.scoped),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test test/auto-pr/diff-toolkit.test.ts 2>&1 | grep -A3 "error responses"
```

Expected: tests fail because current code returns `"Error: <message>"` without the `[TOOL_ERROR]` prefix.

- [ ] **Step 3: Update error formatting in `src/auto-pr/diff-toolkit.ts`**

Replace both error handlers in `makeDiffToolkitLayer`. The current code has:
```typescript
.pipe(Effect.catch((e) => Effect.succeed(`Error: ${e.message}`)))
```

Change both to:
```typescript
.pipe(Effect.catch((e) => Effect.succeed(`[TOOL_ERROR] get_diff failed: ${e.message}\nNo diff available for this request.`)))
```

and:
```typescript
.pipe(Effect.catch((e) => Effect.succeed(`[TOOL_ERROR] get_commit_diff failed: ${e.message}\nNo diff available for this request.`)))
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test test/auto-pr/diff-toolkit.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auto-pr/diff-toolkit.ts test/auto-pr/diff-toolkit.test.ts
git commit -m "fix(diff-toolkit): prefix tool error responses with [TOOL_ERROR] for clear AI signal"
```

---

### Task 5: Visible config defaults (URL and model warnings)

**Files:**
- Modify: `src/auto-pr/config.ts` — add `Effect.logWarning` when URL and model fall back to defaults
- Modify: `test/auto-pr/config.test.ts` — add tests verifying warnings are emitted

- [ ] **Step 1: Write tests for config default warnings**

Config warnings are emitted via `Effect.logWarning`. To capture them, add a log-capturing helper in the test and verify the log output contains the expected warning. Add to `test/auto-pr/config.test.ts`:

```typescript
describe("GeneratePrContentConfigLayer emits warnings for default values", () => {
  test("warns when AUTO_PR_AI_OPENAI_COMPAT_URL is not set", async () => {
    const captured: Array<unknown> = [];
    const CapturingLoggerLayer = Logger.layer([
      Logger.make(({ message }) => {
        for (const m of message) {
          captured.push(m);
        }
      }),
    ]);

    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...generatePrContentBaseEnv,
        AUTO_PR_AI_PROVIDER: "local",
        AUTO_PR_AI_OPENAI_COMPAT_MODEL: "gpt-oss",
        // No AUTO_PR_AI_OPENAI_COMPAT_URL
      }),
    );
    const layer = Layer.mergeAll(
      AutoPrPlatformLayer,
      CapturingLoggerLayer,
      GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        yield* GeneratePrContentConfig;
        const msgs = captured.map(String).join(" ");
        expect(msgs).toContain("AUTO_PR_AI_OPENAI_COMPAT_URL not set");
        expect(msgs).toContain("http://127.0.0.1:8080/v1");
      }),
    );
  });

  test("warns when AUTO_PR_AI_OPENAI_COMPAT_MODEL is not set (local provider)", async () => {
    const captured: Array<unknown> = [];
    const CapturingLoggerLayer = Logger.layer([
      Logger.make(({ message }) => {
        for (const m of message) {
          captured.push(m);
        }
      }),
    ]);

    const providerLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...generatePrContentBaseEnv,
        AUTO_PR_AI_PROVIDER: "local",
        // No AUTO_PR_AI_OPENAI_COMPAT_MODEL
      }),
    );
    const layer = Layer.mergeAll(
      AutoPrPlatformLayer,
      CapturingLoggerLayer,
      GeneratePrContentConfigLayer.pipe(Layer.provide(providerLayer)),
    );
    await runEffect(layer)(
      Effect.gen(function* () {
        yield* GeneratePrContentConfig;
        const msgs = captured.map(String).join(" ");
        expect(msgs).toContain("AUTO_PR_AI_OPENAI_COMPAT_MODEL not set");
        expect(msgs).toContain("gpt-oss");
      }),
    );
  });
});
```

Also add `Logger` to the imports at the top of `test/auto-pr/config.test.ts`:
```typescript
import { Cause, ConfigProvider, Effect, Exit, Layer, Logger, Redacted, Result } from "effect";
import { AutoPrPlatformLayer } from "#auto-pr";
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test test/auto-pr/config.test.ts 2>&1 | grep -A3 "emits warnings"
```

Expected: tests fail because no warnings are emitted for URL/model defaults.

- [ ] **Step 3: Add URL default warning in `GeneratePrContentConfigLayer` (local provider branch)**

In `src/auto-pr/config.ts`, inside `GeneratePrContentConfigLayer`'s `Match.when("local", ...)` block, after the default URL is assigned:

```typescript
const openaiCompatUrl = Option.getOrElse(
  base.aiOpenaiCompatUrl,
  () => DEFAULT_OPENAI_COMPAT_URL,
);
yield* Option.match(base.aiOpenaiCompatUrl, {
  onNone: () =>
    Effect.logWarning(
      `AUTO_PR_AI_OPENAI_COMPAT_URL not set, defaulting to ${DEFAULT_OPENAI_COMPAT_URL}`,
    ),
  onSome: () => Effect.void,
});
const url = yield* requireNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_URL", openaiCompatUrl);
const model = Option.getOrElse(
  base.aiOpenaiCompatModel,
  () => DEFAULT_OPENAI_COMPAT_MODEL,
);
yield* Option.match(base.aiOpenaiCompatModel, {
  onNone: () =>
    Effect.logWarning(
      `AUTO_PR_AI_OPENAI_COMPAT_MODEL not set, defaulting to ${DEFAULT_OPENAI_COMPAT_MODEL}`,
    ),
  onSome: () => Effect.void,
});
const modelId = yield* requireNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_MODEL", model);
```

- [ ] **Step 4: Add model default warning in `GeneratePrContentConfigLayer` (github-models branch)**

In `src/auto-pr/config.ts`, inside `GeneratePrContentConfigLayer`'s `Match.when("github-models", ...)` block:

```typescript
const model = Option.getOrElse(
  base.aiOpenaiCompatModel,
  () => DEFAULT_GITHUB_MODELS_MODEL,
);
yield* Option.match(base.aiOpenaiCompatModel, {
  onNone: () =>
    Effect.logWarning(
      `AUTO_PR_AI_OPENAI_COMPAT_MODEL not set, defaulting to ${DEFAULT_GITHUB_MODELS_MODEL}`,
    ),
  onSome: () => Effect.void,
});
const modelId = yield* requireNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_MODEL", model);
```

- [ ] **Step 5: Add the same warnings in `RunAutoPrConfigLayer`**

Mirror the same `Option.match` warning calls in `RunAutoPrConfigLayer`'s local provider branch (for URL and model) and github-models branch (for model). Follow the exact same pattern as above.

- [ ] **Step 6: Run tests to verify they pass**

```bash
bun test test/auto-pr/config.test.ts
```

Expected: all tests PASS.

- [ ] **Step 7: Run full suite**

```bash
bun test
```

Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/auto-pr/config.ts test/auto-pr/config.test.ts
git commit -m "feat(config): log warning when URL or model falls back to default"
```

---

### Task 6: Move `truncateForLog` to shared location

**Files:**
- Modify: `src/core/string.ts` — add `truncateForLog(s: string, maxChars: number): string`
- Modify: `src/workflow/auto-pr-generate-content.ts` — replace local `truncateForLog` with import from `#core/string.js`

This is a pure refactor with no behavior change. No new tests needed (existing tests in `generate-pr-content.test.ts` already cover its usage).

- [ ] **Step 1: Add `truncateForLog` to `src/core/string.ts`**

Add at the end of `src/core/string.ts`:

```typescript
/**
 * Truncate a string for log output. Returns the trimmed string if within limit,
 * otherwise truncates and appends an indicator with the full length.
 */
export function truncateForLog(s: string, maxChars: number): string {
  const t = s.trim();
  if (t.length <= maxChars) {
    return t;
  }
  return `${t.slice(0, maxChars)}… (${t.length} chars total)`;
}
```

- [ ] **Step 2: Update import in `src/workflow/auto-pr-generate-content.ts`**

Add `truncateForLog` to the `#core/string.js` or `#core` import path. Looking at the existing imports, `isBlank` comes from `#core/fill-pr-template-core.js`, not `#core/string.js` directly. However, `auto-pr-generate-content.ts` imports from `#auto-pr` which re-exports from `#core/index.js`. Let's import directly:

In `src/workflow/auto-pr-generate-content.ts`, remove the local `truncateForLog` function definition (lines 151–157 in the current file), and add to the existing import from `#core/fill-pr-template-core.js` (or add a separate import):

```typescript
import { truncateForLog } from "#core/string.js";
```

- [ ] **Step 3: Verify `#core/string.js` alias resolves correctly**

Check that `src/core/string.ts` is accessible as `#core/string.js`. Looking at `src/auto-pr/utils.ts` which already imports `import { unknownToMessage as unknownToMessageCore } from "#core/string.js";` — confirmed the alias works.

- [ ] **Step 4: Run tests to verify nothing breaks**

```bash
bun test
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/string.ts src/workflow/auto-pr-generate-content.ts
git commit -m "refactor(string): move truncateForLog to src/core/string.ts for shared use"
```

---

### Task 7: Tool use logging in DiffToolkit handlers

**Files:**
- Modify: `src/auto-pr/diff-toolkit.ts` — add request/response log entries with `Effect.tap`, use `truncateForLog` from `#core/string.js`
- Modify: `test/auto-pr/diff-toolkit.test.ts` — verify log entries are emitted

- [ ] **Step 1: Write failing tests for tool use logging**

Add to `test/auto-pr/diff-toolkit.test.ts`. First add `Logger` to imports:
```typescript
import { Effect, Layer, Logger, Option, Stream } from "effect";
```

Add a new describe block:

```typescript
describe("DiffToolkit tool use logging", () => {
  test("get_diff logs request and response events", async () => {
    const captured: Array<unknown> = [];
    const CapturingLoggerLayer = Logger.layer([
      Logger.make(({ message }) => {
        for (const m of message) {
          captured.push(m);
        }
      }),
    ]);

    const mockGitCtx = createGitContextMock({
      getDiff: () => Effect.succeed("diff --git a/foo.ts b/foo.ts\n+const x = 1;"),
    });
    const toolkitLayer = makeDiffToolkitLayer("origin/main", "ai/feature");
    const gitLayer = Layer.succeed(GitContext, mockGitCtx);
    const TestLayer = Layer.mergeAll(
      AutoPrPlatformLayer,
      CapturingLoggerLayer,
      toolkitLayer.pipe(Layer.provide(gitLayer)),
    );
    await runEffect(TestLayer)(
      Effect.gen(function* () {
        const toolkit = yield* DiffToolkit;
        const stream = yield* toolkit.handle("get_diff", { path: "foo.ts" });
        yield* Stream.runLast(stream);

        const msgs = captured.map((m) => (typeof m === "object" ? JSON.stringify(m) : String(m))).join(" ");
        expect(msgs).toContain("diff_toolkit");
        expect(msgs).toContain("get_diff");
        expect(msgs).toContain("request");
        expect(msgs).toContain("response");
        expect(msgs).toContain("foo.ts");
      }).pipe(Effect.scoped),
    );
  });

  test("get_diff logs error message in response on failure", async () => {
    const captured: Array<unknown> = [];
    const CapturingLoggerLayer = Logger.layer([
      Logger.make(({ message }) => {
        for (const m of message) {
          captured.push(m);
        }
      }),
    ]);

    const mockGitCtx = createGitContextMock({
      getDiff: () => Effect.fail(new Error("ref not found")),
    });
    const toolkitLayer = makeDiffToolkitLayer("origin/main", "ai/feature");
    const gitLayer = Layer.succeed(GitContext, mockGitCtx);
    const TestLayer = Layer.mergeAll(
      AutoPrPlatformLayer,
      CapturingLoggerLayer,
      toolkitLayer.pipe(Layer.provide(gitLayer)),
    );
    await runEffect(TestLayer)(
      Effect.gen(function* () {
        const toolkit = yield* DiffToolkit;
        const stream = yield* toolkit.handle("get_diff", { path: "bar.ts" });
        yield* Stream.runLast(stream);

        const msgs = captured.map((m) => (typeof m === "object" ? JSON.stringify(m) : String(m))).join(" ");
        expect(msgs).toContain("diff_toolkit");
        expect(msgs).toContain("error");
        expect(msgs).toContain("ref not found");
      }).pipe(Effect.scoped),
    );
  });
});
```

Also add `AutoPrPlatformLayer` to the imports from `#auto-pr` in `test/auto-pr/diff-toolkit.test.ts`:
```typescript
import { AutoPrPlatformLayer, DiffToolkit, makeDiffToolkitLayer } from "#auto-pr/diff-toolkit.js";
```

Wait — `AutoPrPlatformLayer` lives in `#auto-pr` not `#auto-pr/diff-toolkit.js`. Update imports at the top:
```typescript
import { DiffToolkit, makeDiffToolkitLayer } from "#auto-pr/diff-toolkit.js";
import { AutoPrPlatformLayer } from "#auto-pr";
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test test/auto-pr/diff-toolkit.test.ts 2>&1 | grep -A3 "tool use logging"
```

Expected: logging tests fail because no logging is currently emitted in handlers.

- [ ] **Step 3: Add logging to `src/auto-pr/diff-toolkit.ts`**

Update `makeDiffToolkitLayer` to use `truncateForLog` and emit log entries. Full updated `src/auto-pr/diff-toolkit.ts`:

```typescript
/**
 * Effect Toolkit for AI-accessible git diff tools.
 * Tools: get_diff (branch diff, optionally per-file), get_commit_diff (single commit).
 * Handlers delegate to GitContext.
 */

import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { truncateForLog } from "#core/string.js";
import { GitContext } from "#auto-pr/git-context.js";

const GetDiff = Tool.make("get_diff", {
  description: "Get the git diff for changed files. Provide path for one file, omit for all.",
  parameters: Schema.Struct({
    path: Schema.optionalKey(
      Schema.String.annotate({ description: "File path to diff. Omit for all changed files." }),
    ),
  }),
  success: Schema.String,
  failureMode: "return" as const,
});

const GetCommitDiff = Tool.make("get_commit_diff", {
  description: "Get the diff introduced by a specific commit by its hash.",
  parameters: Schema.Struct({
    hash: Schema.String.annotate({
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
          yield* Effect.log({
            event: "diff_toolkit",
            tool: "get_diff",
            status: "request",
            path: path ?? "(all)",
          });
          const result = yield* git
            .getDiff(baseRef, headRef, path)
            .pipe(
              Effect.tapError((e) =>
                Effect.log({
                  event: "diff_toolkit",
                  tool: "get_diff",
                  status: "error",
                  error: e.message,
                }),
              ),
              Effect.catch((e) =>
                Effect.succeed(
                  `[TOOL_ERROR] get_diff failed: ${e.message}\nNo diff available for this request.`,
                ),
              ),
            );
          yield* Effect.log({
            event: "diff_toolkit",
            tool: "get_diff",
            status: "response",
            response_chars: result.length,
            response_preview: truncateForLog(result, 500),
          });
          return result;
        }),
        get_commit_diff: Effect.fn("DiffToolkit.get_commit_diff")(function* ({ hash }) {
          yield* Effect.log({
            event: "diff_toolkit",
            tool: "get_commit_diff",
            status: "request",
            hash,
          });
          const result = yield* git
            .getCommitDiff(hash)
            .pipe(
              Effect.tapError((e) =>
                Effect.log({
                  event: "diff_toolkit",
                  tool: "get_commit_diff",
                  status: "error",
                  error: e.message,
                }),
              ),
              Effect.catch((e) =>
                Effect.succeed(
                  `[TOOL_ERROR] get_commit_diff failed: ${e.message}\nNo diff available for this request.`,
                ),
              ),
            );
          yield* Effect.log({
            event: "diff_toolkit",
            tool: "get_commit_diff",
            status: "response",
            response_chars: result.length,
            response_preview: truncateForLog(result, 500),
          });
          return result;
        }),
      });
    }),
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test test/auto-pr/diff-toolkit.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Run full suite**

```bash
bun test
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/auto-pr/diff-toolkit.ts test/auto-pr/diff-toolkit.test.ts
git commit -m "feat(diff-toolkit): add request/response logging for AI tool calls"
```

---

### Task 8: Token usage logging

**Files:**
- Modify: `src/workflow/auto-pr-generate-content.ts` — add token usage log entry after `LanguageModel.generateText`
- Modify: `test/workflow/generate-pr-content.test.ts` — verify token usage log is emitted
- Modify: `test/test-utils.ts` — add `usage` field to mock fetch response (optional, to test non-null case)

- [ ] **Step 1: Write failing test for token usage logging**

Add to `test/workflow/generate-pr-content.test.ts` a new describe block after the existing 2-commit tests. Import `Logger` from effect at the top, and add `AutoPrPlatformLayer` to the imports from `#auto-pr`:

Add `Logger` to the effect import:
```typescript
import { Cause, Duration, Effect, Exit, FileSystem, Layer, Logger, Redacted, Result } from "effect";
```

Add to `#auto-pr` import:
```typescript
import {
  aiProviderLayerFromConfig,
  AutoPrConfigError,
  AutoPrPlatformLayer,
  ChildProcessSpawnerLayer,
  DiffToolkit,
  NoSemanticCommitsError,
  ParseError,
  TemplateRenderError,
} from "#auto-pr";
```

Add test:
```typescript
describe("token usage logging", () => {
  test("logs token_usage event after successful AI generation", async () => {
    const captured: Array<unknown> = [];
    const CapturingLoggerLayer = Logger.layer([
      Logger.make(({ message }) => {
        for (const m of message) {
          captured.push(m);
        }
      }),
    ]);

    const p = makeParams(twoCommits, {
      fetch: createOpenAiChatCompletionsMockFetch(VALID_AI_RESPONSE),
    });

    const testLayer = Layer.mergeAll(
      AutoPrPlatformLayer,
      CapturingLoggerLayer,
      Layer.succeed(GitContext, p.gitCtx),
      MockDiffToolkitLayer,
      aiProviderLayerFromConfig(
        { provider: p.params.provider, model: p.params.model },
        p.fetch !== undefined ? { fetch: p.fetch } : undefined,
      ),
    );

    await runEffect(testLayer)(
      Effect.gen(function* () {
        yield* generatePrContent(p.params).pipe(Effect.scoped);
        const msgs = captured.map((m) => (typeof m === "object" ? JSON.stringify(m) : String(m))).join(" ");
        expect(msgs).toContain("token_usage");
        expect(msgs).toContain("generate_pr_content");
      }).pipe(Effect.scoped),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test test/workflow/generate-pr-content.test.ts 2>&1 | grep -A3 "token usage"
```

Expected: test fails because no token_usage event is logged.

- [ ] **Step 3: Add token usage logging in `generateTitleAndDescriptionWithToolkit`**

In `src/workflow/auto-pr-generate-content.ts`, in `generateTitleAndDescriptionWithToolkit`, after `const res = yield* LanguageModel.generateText(...)`:

```typescript
const res = yield* LanguageModel.generateText({ prompt, toolkit: DiffToolkit });
yield* Effect.log({
  event: "generate_pr_content",
  step: "token_usage",
  provider,
  model,
  prompt_tokens: res.usage.inputTokens.total ?? null,
  completion_tokens: res.usage.outputTokens.total ?? null,
  total_tokens:
    res.usage.inputTokens.total != null && res.usage.outputTokens.total != null
      ? res.usage.inputTokens.total + res.usage.outputTokens.total
      : null,
});
const raw = yield* decodeTitleDescriptionFromAssistantText(res.text);
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test test/workflow/generate-pr-content.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Run full suite**

```bash
bun test
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workflow/auto-pr-generate-content.ts test/workflow/generate-pr-content.test.ts
git commit -m "feat(generate-content): log token usage after AI text generation"
```

---

## PR 2: Resilience Guards

### Task 9: Git command timeouts

**Files:**
- Modify: `src/auto-pr/git-context.ts` — add `GIT_COMMAND_TIMEOUT`, apply `Effect.timeout` in `run` helper
- Modify: `test/auto-pr/git-context.test.ts` — add test for timeout behavior

- [ ] **Step 1: Write failing test for timeout**

Add to `test/auto-pr/git-context.test.ts`:

```typescript
import { Duration, Effect, Layer } from "effect";
import { GitContextLive } from "#auto-pr/git-context.js";
```

(If `Duration` isn't already imported, add it.)

Add a new describe block:

```typescript
describe("GitContext timeout", () => {
  test("getLog fails with timeout error when git command hangs beyond 30s", async () => {
    // We test timeout by creating a mock GitContextLive with a very short timeout
    // and a git command that runs forever. We do this by overriding the timeout.
    // Since we cannot easily mock the timeout without modifying GitContextLive,
    // we test via the exported GIT_COMMAND_TIMEOUT constant value and the
    // structural behavior: creating a context where the spawner hangs.
    const hangingSpawner = Layer.mock(ChildProcessSpawner)({
      string: () => Effect.never, // never resolves
      streamString: () => Stream.never,
      streamLines: () => Stream.never,
    });

    // Use a very short timeout to make tests fast. We can't inject the timeout
    // into GitContextLive, so we patch at the Effect level using Effect.timeout.
    const shortTimeoutEffect = Effect.gen(function* () {
      const git = yield* GitContext;
      return yield* git.getLog("HEAD~1", "HEAD").pipe(Effect.timeout(Duration.millis(50)));
    }).pipe(
      Effect.provide(
        GitContextLive("/tmp/fake").pipe(
          Layer.provide(hangingSpawner),
        ),
      ),
    );

    const exit = await Effect.runPromise(shortTimeoutEffect.pipe(Effect.exit));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
```

Also import `Exit` and add the needed `Stream` import for the mock. Add at the top of the test file:
```typescript
import { Duration, Effect, Exit, Layer, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { GIT_COMMAND_TIMEOUT } from "#auto-pr/git-context.js";
```

And test that the constant has the right value:
```typescript
test("GIT_COMMAND_TIMEOUT is 30 seconds", () => {
  expect(Duration.toMillis(GIT_COMMAND_TIMEOUT)).toBe(30_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test test/auto-pr/git-context.test.ts 2>&1 | grep -A3 "timeout"
```

Expected: fail because `GIT_COMMAND_TIMEOUT` is not exported and no timeout exists.

- [ ] **Step 3: Add timeout to `src/auto-pr/git-context.ts`**

Import `Duration` from effect and update the `run` helper:

```typescript
import { Duration, Effect, Layer, ServiceMap } from "effect";
```

Add constant after imports:
```typescript
export const GIT_COMMAND_TIMEOUT = Duration.seconds(30);
```

Update the `run` helper inside `GitContextLive`:
```typescript
const run = (cmd: string, args: string[]) =>
  runCommand(cmd, args, workspace).pipe(
    Effect.timeout(GIT_COMMAND_TIMEOUT),
    Effect.mapError((e) => {
      if (e == null || (typeof e === "object" && "_tag" in e && (e as { _tag: string })._tag === "NoSuchElementException")) {
        return new Error(`git ${args[0] ?? cmd} timed out after 30s`);
      }
      return new Error(e instanceof Error ? e.message : String(e));
    }),
    Effect.provideService(ChildProcessSpawner, spawner),
  );
```

**Note on `Effect.timeout`:** In Effect v4 (effect-smol), `Effect.timeout` maps the effect to fail with a `TimeoutException` or `NoSuchElementException` when the duration expires. Check the actual type by looking at usage examples. In effect-smol, `Effect.timeout` returns `Effect<A, E | TimeoutException, R>`. The `TimeoutException` can be checked via `Cause.isTimeoutException`. Use:

```typescript
import { Cause, Duration, Effect, Layer, ServiceMap } from "effect";

const run = (cmd: string, args: string[]) =>
  runCommand(cmd, args, workspace).pipe(
    Effect.timeout(GIT_COMMAND_TIMEOUT),
    Effect.mapError((e) =>
      Cause.isTimeoutException(e)
        ? new Error(`git ${args[0] ?? cmd} timed out after 30s`)
        : new Error(e instanceof Error ? e.message : String(e))
    ),
    Effect.provideService(ChildProcessSpawner, spawner),
  );
```

However, `Effect.timeout` in effect-smol may produce a different type. Look at the actual Effect.timeout signature in the library to use the correct error type. You can check:

```bash
grep -n "timeout" /home/krzysiek/github/Effect-TS/effect-smol/packages/effect/src/Effect.ts | head -20
```

If the exact API differs, adjust accordingly. The key change is wrapping `runCommand` with a 30s timeout and mapping the timeout error to a clear message.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test test/auto-pr/git-context.test.ts
```

Expected: all tests PASS including the timeout constant test.

- [ ] **Step 5: Run full suite**

```bash
bun test
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/auto-pr/git-context.ts test/auto-pr/git-context.test.ts
git commit -m "feat(git-context): add 30s timeout to all git commands to prevent indefinite hangs"
```

---

### Task 10: Diff size limits via `sanitizeDiffForAi`

**Files:**
- Create: `src/core/sanitize-diff.ts` — pure `sanitizeDiffForAi(raw: string): string` with binary filtering, per-file cap, total cap
- Create: `test/core/sanitize-diff.test.ts` — unit tests
- Modify: `src/auto-pr/diff-toolkit.ts` — call `sanitizeDiffForAi` before returning from handlers

- [ ] **Step 1: Write failing tests for `sanitizeDiffForAi`**

Create `test/core/sanitize-diff.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { sanitizeDiffForAi, MAX_PER_FILE_DIFF_CHARS, MAX_TOTAL_DIFF_CHARS } from "#core/sanitize-diff.js";

const makeBinaryFileDiff = (path: string) =>
  `diff --git a/${path} b/${path}\nindex abc..def 100644\nBinary files a/${path} and b/${path} differ\n`;

const makeFileDiff = (path: string, content: string) =>
  `diff --git a/${path} b/${path}\nindex 000..111 100644\n--- a/${path}\n+++ b/${path}\n${content}\n`;

describe("sanitizeDiffForAi", () => {
  test("returns diff unchanged when within limits", () => {
    const diff = makeFileDiff("src/foo.ts", "+const x = 1;\n-const y = 2;");
    const result = sanitizeDiffForAi(diff);
    expect(result).toContain("+const x = 1;");
    expect(result).not.toContain("[truncated");
    expect(result).not.toContain("[binary file");
  });

  test("replaces binary file hunks with [binary file: path] marker", () => {
    const diff = makeBinaryFileDiff("assets/image.png");
    const result = sanitizeDiffForAi(diff);
    expect(result).toContain("[binary file: assets/image.png]");
    expect(result).not.toContain("Binary files");
  });

  test("handles multiple files with one binary", () => {
    const diff =
      makeFileDiff("src/foo.ts", "+const x = 1;") +
      makeBinaryFileDiff("assets/logo.png") +
      makeFileDiff("src/bar.ts", "+const z = 3;");
    const result = sanitizeDiffForAi(diff);
    expect(result).toContain("[binary file: assets/logo.png]");
    expect(result).toContain("+const x = 1;");
    expect(result).toContain("+const z = 3;");
  });

  test("truncates per-file diff exceeding MAX_PER_FILE_DIFF_CHARS", () => {
    const bigContent = "+".repeat(MAX_PER_FILE_DIFF_CHARS + 5000);
    const diff = makeFileDiff("src/big.ts", bigContent);
    const result = sanitizeDiffForAi(diff);
    expect(result.length).toBeLessThan(diff.length);
    expect(result).toContain("[truncated:");
    expect(result).toContain("showing first");
  });

  test("truncates total diff exceeding MAX_TOTAL_DIFF_CHARS", () => {
    // Create enough files to exceed the total cap
    const filesNeeded = Math.ceil(MAX_TOTAL_DIFF_CHARS / (MAX_PER_FILE_DIFF_CHARS / 2)) + 1;
    const diffParts = Array.from({ length: filesNeeded }, (_, i) =>
      makeFileDiff(`src/file${i}.ts`, "+".repeat(MAX_PER_FILE_DIFF_CHARS / 2)),
    );
    const diff = diffParts.join("");
    const result = sanitizeDiffForAi(diff);
    expect(result.length).toBeLessThanOrEqual(MAX_TOTAL_DIFF_CHARS + 200); // allow for truncation marker
    expect(result).toContain("[diff truncated:");
  });

  test("passes through empty string unchanged", () => {
    expect(sanitizeDiffForAi("")).toBe("");
  });

  test("exports MAX_PER_FILE_DIFF_CHARS as 10000", () => {
    expect(MAX_PER_FILE_DIFF_CHARS).toBe(10_000);
  });

  test("exports MAX_TOTAL_DIFF_CHARS as 50000", () => {
    expect(MAX_TOTAL_DIFF_CHARS).toBe(50_000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test test/core/sanitize-diff.test.ts
```

Expected: all tests fail with module not found error.

- [ ] **Step 3: Create `src/core/sanitize-diff.ts`**

Create the file with the pure implementation:

```typescript
/**
 * Pure diff sanitization for AI consumption. No Effect, no I/O.
 * Guards against binary files, oversized per-file diffs, and oversized total diffs.
 */

export const MAX_PER_FILE_DIFF_CHARS = 10_000;
export const MAX_TOTAL_DIFF_CHARS = 50_000;

/**
 * Split a combined diff string into per-file diff blocks.
 * Each block starts with "diff --git".
 */
function splitIntoDiffBlocks(raw: string): string[] {
  const blocks: string[] = [];
  const lines = raw.split("\n");
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      blocks.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    blocks.push(current.join("\n"));
  }
  return blocks.filter((b) => b.trim().length > 0);
}

/**
 * Extract file path from a diff block header line "diff --git a/path b/path".
 * Returns the path from the b/ side.
 */
function extractFilePath(block: string): string {
  const match = block.match(/^diff --git a\/.+ b\/(.+)$/m);
  return match?.[1] ?? "unknown";
}

/**
 * Check if a diff block is for a binary file.
 */
function isBinaryBlock(block: string): boolean {
  return /^Binary files .+ and .+ differ$/m.test(block);
}

/**
 * Sanitize a single diff block: replace binary with marker, truncate if oversized.
 */
function sanitizeBlock(block: string): string {
  const filePath = extractFilePath(block);

  if (isBinaryBlock(block)) {
    return `[binary file: ${filePath}]`;
  }

  if (block.length > MAX_PER_FILE_DIFF_CHARS) {
    const truncated = block.slice(0, MAX_PER_FILE_DIFF_CHARS);
    return `${truncated}\n[truncated: ${block.length} chars total, showing first ${MAX_PER_FILE_DIFF_CHARS}]`;
  }

  return block;
}

/**
 * Sanitize a raw git diff for AI consumption.
 * - Replaces binary file hunks with a `[binary file: path]` marker.
 * - Truncates any single file's diff exceeding {@link MAX_PER_FILE_DIFF_CHARS}.
 * - Truncates the total diff if it exceeds {@link MAX_TOTAL_DIFF_CHARS} after per-file processing.
 */
export function sanitizeDiffForAi(raw: string): string {
  if (raw.length === 0) return raw;

  const blocks = splitIntoDiffBlocks(raw);
  if (blocks.length === 0) return raw;

  const sanitized = blocks.map(sanitizeBlock);

  let result = sanitized.join("\n");

  if (result.length > MAX_TOTAL_DIFF_CHARS) {
    result = `${result.slice(0, MAX_TOTAL_DIFF_CHARS)}\n[diff truncated: total size exceeded ${MAX_TOTAL_DIFF_CHARS} chars]`;
  }

  return result;
}
```

- [ ] **Step 4: Add path alias for `#core/sanitize-diff.js`**

Check the `tsconfig.json` or `bunfig.toml` to verify the `#core` alias resolves to `src/core`. Since `#core/string.js` already works (used in `src/auto-pr/utils.ts`), the new file should be accessible as `#core/sanitize-diff.js` automatically.

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test test/core/sanitize-diff.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/sanitize-diff.ts test/core/sanitize-diff.test.ts
git commit -m "feat(sanitize-diff): add pure sanitizeDiffForAi with binary filter, per-file and total size caps"
```

---

### Task 11: Apply `sanitizeDiffForAi` in DiffToolkit handlers

**Files:**
- Modify: `src/auto-pr/diff-toolkit.ts` — import `sanitizeDiffForAi` and call on git output before returning
- Modify: `test/auto-pr/diff-toolkit.test.ts` — add test that binary files are replaced in handler output

- [ ] **Step 1: Write failing test**

Add to `test/auto-pr/diff-toolkit.test.ts`:

```typescript
describe("DiffToolkit diff sanitization", () => {
  test("get_diff handler replaces binary file marker in output", async () => {
    const mockGitCtx = createGitContextMock({
      getDiff: () =>
        Effect.succeed(
          "diff --git a/assets/img.png b/assets/img.png\nindex abc..def 100644\nBinary files a/assets/img.png and b/assets/img.png differ\n",
        ),
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
        const toolkit = yield* DiffToolkit;
        const stream = yield* toolkit.handle("get_diff", {});
        const last = yield* Stream.runLast(stream);
        const handlerResult = Option.getOrThrow(last);
        const result = String(handlerResult.result);
        expect(result).toContain("[binary file: assets/img.png]");
        expect(result).not.toContain("Binary files");
      }).pipe(Effect.scoped),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test test/auto-pr/diff-toolkit.test.ts 2>&1 | grep -A3 "sanitization"
```

Expected: test fails because no sanitization happens yet.

- [ ] **Step 3: Add `sanitizeDiffForAi` call in handlers**

In `src/auto-pr/diff-toolkit.ts`, import `sanitizeDiffForAi`:

```typescript
import { sanitizeDiffForAi } from "#core/sanitize-diff.js";
```

In the `get_diff` handler, after obtaining `result` from git (but before logging the response), wrap in sanitization. The handler currently assigns `result` via a chain with `.catch`. After the chain, add:

```typescript
const sanitized = sanitizeDiffForAi(result);
yield* Effect.log({
  event: "diff_toolkit",
  tool: "get_diff",
  status: "response",
  response_chars: sanitized.length,
  response_preview: truncateForLog(sanitized, 500),
});
return sanitized;
```

Do the same for `get_commit_diff`. The response log and return value should use `sanitized` instead of `result`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test test/auto-pr/diff-toolkit.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Run full suite**

```bash
bun test
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/auto-pr/diff-toolkit.ts test/auto-pr/diff-toolkit.test.ts
git commit -m "feat(diff-toolkit): sanitize diff output for AI (binary filter, size caps)"
```

---

## Self-Review Against Spec

### Spec coverage check:

| Spec item | Task |
|-----------|------|
| 1. Narrow AI fallback catch (`isTransientAiError`, `Effect.catchIf`) | Task 1 + Task 2 |
| 2. Branch self-reference validation | Task 3 |
| 3. Structured diff toolkit error responses (`[TOOL_ERROR]` prefix) | Task 4 |
| 4. Visible config defaults (URL and model warnings) | Task 5 |
| 5. Tool use logging (request/response in DiffToolkit) | Task 7 |
| 6. Token usage logging (after `generateText`) | Task 8 |
| 7. Git command timeouts (30s timeout in `run` helper) | Task 9 |
| 8. Diff size limits (`sanitizeDiffForAi`) | Task 10 + Task 11 |

All 8 spec items are covered.

### Type consistency check:
- `isTransientAiError` is defined in Task 1 and used in Task 2 — consistent.
- `truncateForLog` is defined in Task 6 and used in Task 7 — `src/core/string.ts` is the canonical location.
- `sanitizeDiffForAi`, `MAX_PER_FILE_DIFF_CHARS`, `MAX_TOTAL_DIFF_CHARS` are defined in Task 10 and used in Task 11 — consistent.
- `GIT_COMMAND_TIMEOUT` is exported in Task 9 and tested for its value — consistent.

### Placeholder check:
All tasks include exact code with no placeholders. ✓
