# Error Handling, Observability & Resilience Improvements

**Goal:** Address identified weaknesses in auto-pr's error handling, config validation, and resilience — plus add observability improvements (tool use logging, token usage logging). Delivered as two thematic PRs.

**Scope:** Eight changes across two PRs (six in PR 1, two in PR 2). No new features, no API changes, no workflow YAML changes.

---

## PR 1: Error Handling & Observability

### 1. Narrow the AI fallback catch

**Problem:** `generateTitleAndDescriptionWithToolkit` in `src/workflow/auto-pr-generate-content.ts` uses `Effect.catch(() => ...)` after retries, treating all failures identically — auth errors, network unreachable, and parse failures all silently produce commit-summary PRs.

**Design:** Split errors into two categories after retries exhaust:

- **Transient/content errors** (parse failures, validation failures, HTTP 5xx, network timeouts, rate limits / 429) — fall back to commit-summary PR with a warning log. This is the existing behavior.
- **Config/auth errors** (HTTP 401/403, invalid URL, connection refused on non-default URL) — fail the workflow with `AutoPrConfigError` and a clear message.

**Implementation:**
- Add `isTransientAiError(e: unknown): boolean` helper in `src/auto-pr/errors.ts`. Inspects error structure: HTTP status codes (401/403 = config error, 429/5xx = transient), connection/network errors (transient), `DescriptionParseError` (transient).
- Replace blanket `Effect.catch` with `Effect.catchIf(isTransientAiError, ...)` — non-transient errors propagate as failures.

**Files:**
- Modify: `src/auto-pr/errors.ts` — add `isTransientAiError`
- Modify: `src/workflow/auto-pr-generate-content.ts` — replace `Effect.catch` with `Effect.catchIf`
- Modify: `test/workflow/generate-pr-content.test.ts` — add tests for auth error propagation and transient error fallback

---

### 2. Branch self-reference validation

**Problem:** Config layers accept `branch === defaultBranch` without complaint, producing meaningless `git diff origin/main..main`.

**Design:** Add a guard in `GeneratePrContentConfigLayer` and `RunAutoPrConfigLayer` after both values are resolved. Fail with `AutoPrConfigError({ missing: ["BRANCH (main) must differ from DEFAULT_BRANCH (main)"] })`.

In `RunAutoPrConfigLayer`, `branch` is optional (`string | undefined`) — only validate when `branch` is defined. `CreateOrUpdatePrConfigLayer` does not need this check (it doesn't perform diffs).

**Files:**
- Modify: `src/auto-pr/config.ts` — add validation after `branch` and `defaultBranch` are resolved, in both `GeneratePrContentConfigLayer` and `RunAutoPrConfigLayer`
- Modify: `test/auto-pr/config.test.ts` — add tests for `branch === defaultBranch` rejection

---

### 3. Structured diff toolkit error responses

**Problem:** `DiffToolkit` handlers catch errors and return `"Error: <message>"` as plain text. The AI model may interpret this as diff content.

**Design:** Return clearly prefixed error text:

```
[TOOL_ERROR] get_diff failed: <message>
No diff available for this request.
```

The tool schema stays `Schema.String` with `failureMode: "return"` — no structural change. The `[TOOL_ERROR]` prefix gives the AI a clear signal.

**Files:**
- Modify: `src/auto-pr/diff-toolkit.ts` — update error formatting in both handlers
- Modify: `test/auto-pr/diff-toolkit.test.ts` — add tests for error response format

---

### 4. Visible config defaults

**Problem:** `AUTO_PR_AI_OPENAI_COMPAT_URL` and `AUTO_PR_AI_OPENAI_COMPAT_MODEL` silently default with no log output. A typo in an env var name goes unnoticed.

**Design:** Log a warning whenever a config value falls back to its default:

- `"AUTO_PR_AI_OPENAI_COMPAT_URL not set, defaulting to http://127.0.0.1:8080/v1"`
- `"AUTO_PR_AI_OPENAI_COMPAT_MODEL not set, defaulting to gpt-oss"` (or the github-models default)

Applied in both `GeneratePrContentConfigLayer` and `RunAutoPrConfigLayer`. No behavior change — just visibility.

**Files:**
- Modify: `src/auto-pr/config.ts` — add `Effect.logWarning` when `Option.isNone` for URL and model options
- Modify: `test/auto-pr/config.test.ts` — verify warnings are emitted (optional, low priority)

---

### 5. Tool use logging

**Problem:** No visibility into AI tool calls. When the model calls `get_diff` or `get_commit_diff`, there's no record of what it asked for or what it received.

**Design:** Add logging in `makeDiffToolkitLayer` handlers. Two log entries per tool call:

**Request:**
```json
{ "event": "diff_toolkit", "tool": "get_diff", "status": "request", "path": "src/foo.ts" }
```

**Response:**
```json
{ "event": "diff_toolkit", "tool": "get_diff", "status": "response", "response_chars": 4230, "response_preview": "diff --git a/src/foo.ts..." }
```

Response preview truncated to 500 chars using the existing `truncateForLog` pattern. On error, logs the error message instead of a preview.

**Files:**
- Modify: `src/auto-pr/diff-toolkit.ts` — wrap handler bodies with `Effect.tap` logging
- May need to move or re-export `truncateForLog` from `src/workflow/auto-pr-generate-content.ts` to a shared location (currently it's a module-private function)
- Modify: `test/auto-pr/diff-toolkit.test.ts` — verify log entries are emitted

---

### 6. Token usage logging

**Problem:** No visibility into how many tokens each PR generation consumes. Useful for cost tracking (especially with GitHub Models billing multipliers), debugging truncated or poor-quality responses, and validating that diff size limits are effective.

**Design:** Log token usage from the `generateText` response. OpenAI-compatible endpoints return `usage.prompt_tokens` and `usage.completion_tokens` in the response body. Add a log entry after the AI call completes successfully:

```json
{ "event": "generate_pr_content", "step": "token_usage", "provider": "github-models", "model": "...", "prompt_tokens": 3200, "completion_tokens": 850, "total_tokens": 4050 }
```

This lives in `generateTitleAndDescriptionWithToolkit` in `src/workflow/auto-pr-generate-content.ts`, after the `LanguageModel.generateText` call returns. If usage data is not present in the response (some providers omit it), log with `null` values rather than skipping the entry — the absence itself is informative.

**Files:**
- Modify: `src/workflow/auto-pr-generate-content.ts` — add token usage log entry after `generateText`
- Modify: `test/workflow/generate-pr-content.test.ts` — verify token usage is logged

---

## PR 2: Resilience Guards

### 7. Git command timeouts

**Problem:** All git commands in `GitContextLive` can hang indefinitely. No timeout protection.

**Design:** Add a 30-second timeout to all git commands.

- Add `GIT_COMMAND_TIMEOUT = Duration.seconds(30)` constant in `src/auto-pr/git-context.ts`
- Apply `Effect.timeout(GIT_COMMAND_TIMEOUT)` in the `run` helper inside `GitContextLive`
- Map `NoSuchElementException` (Effect's timeout signal) to `Error("git <command> timed out after 30s")`
- Timeout applies uniformly to all five operations via the shared `run` helper

**Files:**
- Modify: `src/auto-pr/git-context.ts` — add timeout to `run` helper
- Modify: `test/auto-pr/git-context.test.ts` (or create if it doesn't exist) — test timeout behavior

---

### 8. Diff size limits

**Problem:** `getDiff` and `getCommitDiff` return full diffs. Large repos with binary files or massive generated files can overwhelm the AI context window.

**Design:** Add size guards in the `DiffToolkit` handlers (not in `GitContext` — the raw git interface stays faithful to git output). Three guards:

1. **Binary file filtering:** Detect `Binary files ... differ` markers in git diff output. Replace the hunk with `[binary file: path/to/image.png]`.

2. **Per-file size cap:** If a single file's diff exceeds 10,000 characters (~2.5k tokens), truncate and append `[truncated: 45,230 chars total, showing first 10,000]`.

3. **Total diff cap:** If the complete diff output exceeds 50,000 characters after per-file truncation, truncate with a similar marker.

**Implementation:**
- Add `sanitizeDiffForAi(raw: string): string` as a pure function in a new file `src/core/sanitize-diff.ts`. This is a pure string transformation — no Effect, no I/O.
- `DiffToolkit` handlers call `sanitizeDiffForAi` on git output before returning.
- Constants: `MAX_PER_FILE_DIFF_CHARS = 10_000`, `MAX_TOTAL_DIFF_CHARS = 50_000` — hardcoded, no env config.

**Files:**
- Create: `src/core/sanitize-diff.ts` — pure `sanitizeDiffForAi` function
- Create: `test/core/sanitize-diff.test.ts` — unit tests for binary filtering, per-file truncation, total truncation, and passthrough for normal-sized diffs
- Modify: `src/auto-pr/diff-toolkit.ts` — call `sanitizeDiffForAi` on results

---

## Out of scope

- Effect beta pinning strategy (separate concern, not an error/resilience issue)
- Test coverage for commit parsing edge cases (not related to these six issues)
- Changing `DiffToolkit` schema from `Schema.String` to structured objects (unnecessary complexity)
