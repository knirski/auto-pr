# Effect Idiom & Type-Safety Hardening Implementation Plan

**Implementation status (2026-04-20):** Work was executed in-repo. This plan is preserved as an execution record; checkbox states (`- [ ]` and `- [x]`) should be read as historical plan tracking, not current TODOs.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten type safety and FC/IS rigor across the PR-writing hot path (`src/workflow/auto-pr-create-or-update-pr.ts`), the AI provider layer (`src/auto-pr/live/ai-provider.ts`), `src/core/errors.ts`, and `src/auto-pr/config.ts`, using only the project's existing idioms.

**Architecture:** Three logical PRs. **PR A** (Tasks 1-2) replaces silent catches in `ghPrViewJson` with a typed `PullRequestLookupError` and moves fragile PR-URL parsing to a pure core helper `parseGhPrCreateOutput` returning `Result`. **PR B** (Task 3) removes two `as Layer.Layer<…>` casts in the AI provider so `Match.exhaustive` carries real type information. **PR C** (Tasks 4-6) narrows `Schema.Unknown` cause fields on tagged errors, unifies the config warn-on-default pattern into `getOrDefaultLogged`, and adds pure URL-shape validation for `AUTO_PR_AI_OPENAI_COMPAT_URL`.

**Tech Stack:** TypeScript, Effect v4 beta (`effect`, `@effect/ai-openai-compat`, `@effect/platform-bun`), bun:test, Biome, Nix, Lefthook. Pinned via `package.json`; run `bun run check:code` to verify.

**Effect v4 API reference order:** when an Effect v4 signature is unclear, consult in order: (1) `https://github.com/Effect-TS/effect-smol/blob/main/LLMS.md` (local clone at `/home/krzysiek/github/Effect-TS/effect-smol/LLMS.md`), (2) the `effect-smol` source tree (`packages/*`), (3) context7 / web only as a fallback. Effect v4 is still in beta; third-party docs lag.

**Design source:** `docs/superpowers/specs/2026-04-19-effect-hardening-design.md`.

---

## File structure (what this plan touches)

**New files:**
- `src/core/gh-pr-url.ts` — pure `parseGhPrCreateOutput(stdout)` returning `Result<string, PullRequestUrlParseError>`.
- `src/core/openai-compat-url.ts` — pure `parseOpenAiCompatUrl(raw)` returning `Result<string, { reason }>`.
- `test/core/gh-pr-url.test.ts` — pure unit tests for the URL parser.
- `test/core/openai-compat-url.test.ts` — pure unit tests for the URL validator.

**Modified files:**
- `src/core/errors.ts` — add `PullRequestLookupError`, `PullRequestUrlParseError`; narrow `ParseError.cause` and `TemplateRenderError.cause` from `Schema.Unknown` → `Schema.String`.
- `src/auto-pr/errors.ts` — integrate two new errors (import, re-export, `instanceof` guard, `Match.tag`); simplify the `String(cause)` calls in `ParseError`/`TemplateRenderError` branches.
- `src/workflow/auto-pr-create-or-update-pr.ts` — rewrite `ghPrViewJson` (lines 40-59), delete `extractPrUrl` (lines 129-131), call `parseGhPrCreateOutput` via `Effect.fromResult`, widen `CreateOrUpdatePrError` union.
- `src/auto-pr/live/ai-provider.ts` — remove two `as Layer.Layer<…>` casts (lines 47 and 96).
- `src/auto-pr/config.ts` — add private `getOrDefaultLogged` helper; replace 3-5 warn-on-default call sites; integrate `parseOpenAiCompatUrl` after the existing `requireNonEmpty` at `:205`.
- `test/workflow/create-or-update-pr.test.ts` — append tests for `ghPrViewJson` outcomes.
- `test/auto-pr/errors.test.ts` — add `formatError` tests for `PullRequestLookupError`, `PullRequestUrlParseError`; assert `ParseError.cause` flows as string.
- `test/core/errors.test.ts` — add constructor tests for the two new error classes.

**Sweep files** (touched by Task 4 caller sweep; exact list emerges from grep):
- Any file constructing `new ParseError({…})` or `new TemplateRenderError({…})` where `cause` is not already a `string`.

---

## PR A — PR-lifecycle correctness

Two tasks, one PR, two commits.

### Task 1: Typed `ghPrViewJson` with `PullRequestLookupError`

**Files:**
- Modify: `src/core/errors.ts` (add `PullRequestLookupError` class near `PullRequestFailedError`)
- Modify: `src/auto-pr/errors.ts` (import, re-export, `instanceof` chain, `Match.tag` branch)
- Modify: `src/workflow/auto-pr-create-or-update-pr.ts:40-59` (rewrite `ghPrViewJson`; widen `CreateOrUpdatePrError` at `:133`)
- Test: `test/core/errors.test.ts` (add constructor test)
- Test: `test/auto-pr/errors.test.ts` (add `formatError` test)
- Test: `test/workflow/create-or-update-pr.test.ts` (append new test cases)

- [x] **Step 1: Research `runCommand` error transformation**

Before writing code, confirm how `runCommand` surfaces spawner errors. Run:

```bash
grep -n "function runCommand\|export function runCommand\|runCommand =" src/auto-pr/shell.ts
```

Read the function. Answer: when the spawner fails with a `PlatformError.systemError` (e.g., gh exits non-zero), does `runCommand` wrap it in `PullRequestFailedError`, or propagate the raw `systemError`? Record the answer; it decides which error shape the predicate below matches.

If unclear, consult LLMS.md § on `Effect.catch` / `Effect.catchTag` and the `effect-smol/packages/unstable-process` source.

- [x] **Step 2: Add `PullRequestLookupError` class**

In `src/core/errors.ts`, add after the `PullRequestFailedError` class (around line 14):

```ts
/** `gh pr view` failed or returned unparseable JSON. Distinct from "no PR yet" (Option.none). */
export class PullRequestLookupError extends Schema.TaggedErrorClass<PullRequestLookupError>()(
	"PullRequestLookupError",
	{ branch: Schema.String, cause: Schema.String },
) {}
```

- [x] **Step 3: Add failing constructor test**

Append to `test/core/errors.test.ts`:

```ts
import { PullRequestLookupError } from "#core/errors.js";

test("PullRequestLookupError carries branch and cause", () => {
	const e = new PullRequestLookupError({ branch: "ai/foo", cause: "gh auth error" });
	expect(e._tag).toBe("PullRequestLookupError");
	expect(e.branch).toBe("ai/foo");
	expect(e.cause).toBe("gh auth error");
});
```

Run:

```bash
bun test test/core/errors.test.ts
```

Expected: PASS (the class already exists from Step 2).

- [x] **Step 4: Integrate `PullRequestLookupError` in `formatError` (five-point integration)**

In `src/auto-pr/errors.ts`:

- Add to the import block from `#core/errors.js` (around line 14-28), alphabetised:

```ts
PullRequestLookupError,
```

- Add to the re-export block (around line 30-44):

```ts
PullRequestLookupError,
```

- Add to the `instanceof` guard chain in `formatError` (around line 52-64), alphabetised among peers:

```ts
e instanceof PullRequestLookupError ||
```

- Add a `Match.tag` branch before `Match.exhaustive` (near line 67-102):

```ts
Match.tag("PullRequestLookupError", ({ branch, cause }) =>
	`Failed to look up PR for branch ${branch}: ${cause}`,
),
```

- [x] **Step 5: Add failing `formatError` test for `PullRequestLookupError`**

Append to `test/auto-pr/errors.test.ts`:

```ts
import { PullRequestLookupError } from "#core/errors.js";

test("formatError formats PullRequestLookupError", () => {
	const out = formatError(new PullRequestLookupError({ branch: "ai/foo", cause: "boom" }));
	expect(out).toContain("ai/foo");
	expect(out).toContain("boom");
});
```

Run:

```bash
bun test test/auto-pr/errors.test.ts
```

Expected: PASS (integration complete from Step 4).

- [x] **Step 6: Add failing tests for the new `ghPrViewJson` behaviour**

Append to `test/workflow/create-or-update-pr.test.ts` (the file already exists; use the same imports and `Layer.mock(ChildProcessSpawner)(…)` pattern shown at the top of the file and in `#test/test-utils.js`):

```ts
import { Exit, Option, Stream } from "effect";
import { systemError } from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { PullRequestLookupError } from "#core/errors.js";
import { ghPrViewJson } from "#workflow/auto-pr-create-or-update-pr.js";

describe("ghPrViewJson", () => {
	test("returns Option.none when gh reports no PR", async () => {
		const mock = Layer.mock(ChildProcessSpawner)({
			string: () =>
				Effect.fail(
					systemError({
						_tag: "NotFound",
						module: "gh",
						method: "pr view",
						description: "no pull requests found",
					}),
				),
			streamString: () => Stream.empty,
			streamLines: () => Stream.empty,
		});
		await runEffect(Layer.mergeAll(TestBaseLayer, SilentLoggerLayer, mock))(
			Effect.gen(function* () {
				const result = yield* ghPrViewJson("ai/foo", "/tmp");
				expect(Option.isNone(result)).toBe(true);
			}),
		);
	});

	test("returns Option.some when gh returns valid JSON", async () => {
		const mock = Layer.mock(ChildProcessSpawner)({
			string: () => Effect.succeed('{"number":42,"url":"https://github.com/o/r/pull/42"}'),
			streamString: () => Stream.empty,
			streamLines: () => Stream.empty,
		});
		await runEffect(Layer.mergeAll(TestBaseLayer, SilentLoggerLayer, mock))(
			Effect.gen(function* () {
				const result = yield* ghPrViewJson("ai/foo", "/tmp");
				expect(Option.isSome(result)).toBe(true);
				if (Option.isSome(result)) {
					expect(result.value.number).toBe(42);
					expect(result.value.url).toBe("https://github.com/o/r/pull/42");
				}
			}),
		);
	});

	test("fails with PullRequestLookupError on malformed JSON", async () => {
		const mock = Layer.mock(ChildProcessSpawner)({
			string: () => Effect.succeed("not-json"),
			streamString: () => Stream.empty,
			streamLines: () => Stream.empty,
		});
		await runEffect(Layer.mergeAll(TestBaseLayer, SilentLoggerLayer, mock))(
			Effect.gen(function* () {
				const exit = yield* Effect.exit(ghPrViewJson("ai/foo", "/tmp"));
				expect(Exit.isFailure(exit)).toBe(true);
				if (Exit.isFailure(exit)) {
					const failure = Array.from(exit.cause.failures)[0];
					expect(failure).toBeInstanceOf(PullRequestLookupError);
				}
			}),
		);
	});

	test("fails with PullRequestLookupError on schema mismatch", async () => {
		const mock = Layer.mock(ChildProcessSpawner)({
			string: () => Effect.succeed('{"wrong":"shape"}'),
			streamString: () => Stream.empty,
			streamLines: () => Stream.empty,
		});
		await runEffect(Layer.mergeAll(TestBaseLayer, SilentLoggerLayer, mock))(
			Effect.gen(function* () {
				const exit = yield* Effect.exit(ghPrViewJson("ai/foo", "/tmp"));
				expect(Exit.isFailure(exit)).toBe(true);
			}),
		);
	});
});
```

Notes:
- If `ghPrViewJson` is not already exported from `auto-pr-create-or-update-pr.ts`, export it in Step 7. The implementer must verify via grep.
- `Array.from(exit.cause.failures)[0]` is the idiomatic v4 way to extract the first failure from a `Cause`. If LLMS.md documents a different accessor, prefer that.

Run:

```bash
bun test test/workflow/create-or-update-pr.test.ts
```

Expected: FAIL — either "ghPrViewJson is not exported," the malformed-JSON test returns `Option.none` (old behaviour) instead of failing, or the schema-mismatch test passes as `Option.none` instead of failing.

- [x] **Step 7: Rewrite `ghPrViewJson`**

Replace `src/workflow/auto-pr-create-or-update-pr.ts:40-59` with:

```ts
/** Heuristic: true if the error message indicates "PR does not exist" rather than a real failure. */
function looksLikeNoPrError(e: unknown): boolean {
	const msg = String(e).toLowerCase();
	return msg.includes("no pull") || msg.includes("no pr") || msg.includes("not found");
}

/** PR existence check: Option.none when no PR; fail with PullRequestLookupError on every other error. */
export function ghPrViewJson(
	branch: string,
	cwd: string,
): Effect.Effect<Option.Option<PullRequestInfo>, PullRequestLookupError, ChildProcessSpawner> {
	const toLookupError = (cause: unknown): PullRequestLookupError =>
		new PullRequestLookupError({ branch, cause: String(cause) });

	return Effect.gen(function* () {
		const stdout = yield* runCommand("gh", ["pr", "view", branch, "--json", "number,url"], cwd).pipe(
			Effect.catch((e) =>
				looksLikeNoPrError(e) ? Effect.succeed("") : Effect.fail(toLookupError(e)),
			),
		);
		const trimmed = stdout.trim();
		if (trimmed === "") return Option.none();

		const parsed = yield* Effect.fromResult(parseFirstJsonObject(trimmed)).pipe(
			Effect.mapError(toLookupError),
		);
		const decoded = yield* Schema.decodeUnknownEffect(PullRequestInfoSchema)(parsed).pipe(
			Effect.mapError(toLookupError),
		);
		return Option.some(decoded);
	});
}
```

Add imports at the top of the file (alphabetise existing imports):

```ts
import { parseFirstJsonObject } from "#core/parse-model-json.js";
import { PullRequestLookupError } from "#core/errors.js";
```

Remove now-unused imports (e.g., the inline `Effect.try(JSON.parse…)` block's `Effect.try`/etc. is gone; `tsgo` will flag dead imports).

- [x] **Step 8: Widen `CreateOrUpdatePrError`**

At `src/workflow/auto-pr-create-or-update-pr.ts:133`, change:

```ts
type CreateOrUpdatePrError = PullRequestFailedError | BodyFileNotFoundError | FileSystemError;
```

to:

```ts
type CreateOrUpdatePrError =
	| PullRequestFailedError
	| BodyFileNotFoundError
	| FileSystemError
	| PullRequestLookupError;
```

- [x] **Step 9: Verify `bun run check:code` passes**

Run:

```bash
bun run check:code
```

Expected: exit code 0. If `tsgo` complains about a missing `Match.tag` branch in `formatError`, that's a genuine miss — add it. If tests fail because a caller changed behaviour, inspect the caller (likely `runCreateOrUpdatePr` near `:154`); the calling code already handles `Option` outputs and any `yield*`-propagated error, so no caller-code change should be needed.

- [x] **Step 10: Commit**

```bash
git add src/core/errors.ts src/auto-pr/errors.ts \
	src/workflow/auto-pr-create-or-update-pr.ts \
	test/core/errors.test.ts test/auto-pr/errors.test.ts \
	test/workflow/create-or-update-pr.test.ts
git commit -m "refactor(workflow): typed PullRequestLookupError instead of silent catch in ghPrViewJson"
```

---

### Task 2: Pure `parseGhPrCreateOutput` in core

**Files:**
- Create: `src/core/gh-pr-url.ts`
- Create: `test/core/gh-pr-url.test.ts`
- Modify: `src/core/errors.ts` (add `PullRequestUrlParseError`)
- Modify: `src/auto-pr/errors.ts` (five-point integration)
- Modify: `src/workflow/auto-pr-create-or-update-pr.ts` (delete `extractPrUrl:129-131`, call `parseGhPrCreateOutput`, widen `CreateOrUpdatePrError`)
- Test: `test/auto-pr/errors.test.ts` (format test)
- Test: `test/core/errors.test.ts` (constructor test)

- [x] **Step 1: Research — is there a reusable URL helper?**

Run:

```bash
grep -rn "Url\.fromString\|\"#core/url" src/ test/ 2>/dev/null
```

If a project-internal `Url.fromString` exists and accepts arbitrary http(s) URLs returning a `Result<URL, E>`, reuse it inside `parseGhPrCreateOutput`. If it's limited (e.g., only `import.meta.url`-style parsing as used in `src/tools/auto-pr-init.ts:34`), fall back to regex validation below and add a one-line comment justifying.

Consult `effect-smol/LLMS.md` for Effect v4's URL parsing primitives if LLMS.md covers them.

- [x] **Step 2: Add `PullRequestUrlParseError` class**

In `src/core/errors.ts`, add after `PullRequestLookupError`:

```ts
/** `gh pr create` output could not be parsed into a PR URL. */
export class PullRequestUrlParseError extends Schema.TaggedErrorClass<PullRequestUrlParseError>()(
	"PullRequestUrlParseError",
	{ raw: Schema.String, reason: Schema.String },
) {}
```

- [x] **Step 3: Constructor test for `PullRequestUrlParseError`**

Append to `test/core/errors.test.ts`:

```ts
import { PullRequestUrlParseError } from "#core/errors.js";

test("PullRequestUrlParseError carries raw and reason", () => {
	const e = new PullRequestUrlParseError({ raw: "garbage", reason: "not a URL" });
	expect(e._tag).toBe("PullRequestUrlParseError");
	expect(e.raw).toBe("garbage");
	expect(e.reason).toBe("not a URL");
});
```

Run:

```bash
bun test test/core/errors.test.ts
```

Expected: PASS.

- [x] **Step 4: Integrate `PullRequestUrlParseError` in `formatError` (five-point integration)**

In `src/auto-pr/errors.ts`:

- Add to import block:

```ts
PullRequestUrlParseError,
```

- Add to re-export block:

```ts
PullRequestUrlParseError,
```

- Add to `instanceof` guard chain, alphabetised:

```ts
e instanceof PullRequestUrlParseError ||
```

- Add `Match.tag` branch before `Match.exhaustive`:

```ts
Match.tag("PullRequestUrlParseError", ({ raw, reason }) =>
	`gh PR URL parse failed (${reason}). Raw: ${raw.slice(0, 200)}`,
),
```

- [x] **Step 5: `formatError` test for `PullRequestUrlParseError`**

Append to `test/auto-pr/errors.test.ts`:

```ts
import { PullRequestUrlParseError } from "#core/errors.js";

test("formatError formats PullRequestUrlParseError", () => {
	const out = formatError(new PullRequestUrlParseError({ raw: "hi", reason: "not a URL" }));
	expect(out).toContain("not a URL");
	expect(out).toContain("hi");
});
```

Run:

```bash
bun test test/auto-pr/errors.test.ts
```

Expected: PASS.

- [x] **Step 6: Failing tests for `parseGhPrCreateOutput`**

Create `test/core/gh-pr-url.test.ts`:

```ts
import { expect, test } from "bun:test";
import { Result } from "effect";
import { parseGhPrCreateOutput } from "#core/gh-pr-url.js";

test("parses single-line URL", () => {
	const r = parseGhPrCreateOutput("https://github.com/o/r/pull/42\n");
	expect(Result.isOk(r)).toBe(true);
	if (Result.isOk(r)) expect(r.value).toBe("https://github.com/o/r/pull/42");
});

test("parses last non-empty line from multi-line gh output", () => {
	const r = parseGhPrCreateOutput(
		"Creating pull request for ai/foo into main\n\nhttps://github.com/o/r/pull/7\n",
	);
	expect(Result.isOk(r)).toBe(true);
	if (Result.isOk(r)) expect(r.value).toBe("https://github.com/o/r/pull/7");
});

test("rejects empty output", () => {
	expect(Result.isErr(parseGhPrCreateOutput(""))).toBe(true);
	expect(Result.isErr(parseGhPrCreateOutput("   \n\n"))).toBe(true);
});

test("rejects when last line is not a PR URL", () => {
	expect(Result.isErr(parseGhPrCreateOutput("done"))).toBe(true);
	expect(Result.isErr(parseGhPrCreateOutput("https://github.com/o/r/issues/1"))).toBe(true);
});

test("trims whitespace on URL line", () => {
	const r = parseGhPrCreateOutput("  https://github.com/o/r/pull/5  \n");
	expect(Result.isOk(r)).toBe(true);
	if (Result.isOk(r)) expect(r.value).toBe("https://github.com/o/r/pull/5");
});
```

Run:

```bash
bun test test/core/gh-pr-url.test.ts
```

Expected: FAIL — module `#core/gh-pr-url.js` does not exist.

- [x] **Step 7: Create `src/core/gh-pr-url.ts`**

```ts
import { Result } from "effect";
import { PullRequestUrlParseError } from "./errors.js";

/** GitHub PR URL: https(s)://host/owner/repo/pull/<digits> */
const GH_PR_URL = /^https?:\/\/\S+\/pull\/\d+$/;

/** Pure: extract the PR URL from `gh pr create` stdout. Validates shape. */
export function parseGhPrCreateOutput(stdout: string): Result.Result<string, PullRequestUrlParseError> {
	const lines = stdout
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "");
	const last = lines.at(-1);
	if (last === undefined) {
		return Result.err(new PullRequestUrlParseError({ raw: stdout, reason: "empty output" }));
	}
	if (!GH_PR_URL.test(last)) {
		return Result.err(
			new PullRequestUrlParseError({ raw: stdout, reason: `last line is not a PR URL: ${last}` }),
		);
	}
	return Result.ok(last);
}
```

(If Step 1 found a reusable `Url.fromString` that handles arbitrary http(s) URLs, replace the regex check with that helper and still verify the path matches `/pull/\d+$`.)

Run:

```bash
bun test test/core/gh-pr-url.test.ts
```

Expected: PASS (all 5 cases).

- [x] **Step 8: Wire shell to core — delete `extractPrUrl`, call `parseGhPrCreateOutput`**

In `src/workflow/auto-pr-create-or-update-pr.ts`:

- Delete the `extractPrUrl` function at lines 129-131.
- Add imports near the top (alphabetise):

```ts
import { parseGhPrCreateOutput } from "#core/gh-pr-url.js";
import { PullRequestUrlParseError } from "#core/errors.js";
```

- Find the single call site of `extractPrUrl` (grep):

```bash
grep -n "extractPrUrl(" src/workflow/auto-pr-create-or-update-pr.ts
```

- Replace `const url = extractPrUrl(stdout);` with:

```ts
const url = yield* Effect.fromResult(parseGhPrCreateOutput(stdout));
```

- Widen `CreateOrUpdatePrError` at `:133` to include `PullRequestUrlParseError`:

```ts
type CreateOrUpdatePrError =
	| PullRequestFailedError
	| BodyFileNotFoundError
	| FileSystemError
	| PullRequestLookupError
	| PullRequestUrlParseError;
```

- [x] **Step 9: Optionally add to `src/core/index.ts` re-export**

If `src/core/index.ts` already re-exports helpers from other core modules (check with `head -40 src/core/index.ts`), add alongside:

```ts
export { parseGhPrCreateOutput } from "#core/gh-pr-url.js";
```

Skip if core modules are imported directly without re-exports in this project.

- [x] **Step 10: Verify `bun run check:code` passes**

```bash
bun run check:code
```

Expected: exit code 0.

- [x] **Step 11: Commit**

```bash
git add src/core/errors.ts src/core/gh-pr-url.ts \
	src/auto-pr/errors.ts \
	src/workflow/auto-pr-create-or-update-pr.ts \
	test/core/errors.test.ts test/core/gh-pr-url.test.ts \
	test/auto-pr/errors.test.ts
git commit -m "refactor(core): pure parseGhPrCreateOutput with Result and URL shape validation"
```

*(Include `src/core/index.ts` in the `git add` if Step 9 modified it.)*

---

### PR A — create the pull request

After Tasks 1 and 2 are committed on branch `ai/effect-hardening-pr-a` (or equivalent), push and rely on `auto-pr.yml` to create the PR, or:

```bash
gh pr create \
	--title "refactor: typed PR-lookup error and pure PR-URL parser" \
	--body "Implements PR A from docs/superpowers/plans/2026-04-19-effect-hardening.md (Tasks 1-2)."
```

---

## PR B — AI provider Layer type safety

One task, one PR, one commit.

### Task 3: Remove both `as Layer.Layer<…>` casts in `ai-provider.ts`

**Files:**
- Modify: `src/auto-pr/live/ai-provider.ts:37-48` (inner cast at `:47`)
- Modify: `src/auto-pr/live/ai-provider.ts:56-97` (outer cast at `:96`)

- [x] **Step 1: Research — Effect v4 `OpenAiClient.layer` / `Layer.mergeAll` signatures**

Consult `effect-smol/LLMS.md` for:
- Return type of `OpenAiClient.layer(options: OpenAiClient.Options)` at the project's pinned version.
- Error-channel behaviour of `Layer.provide(childLayer)(parentLayer)`.
- How `Layer.mergeAll(a, b)` unions `a`'s and `b`'s error channels.

If LLMS.md is silent, read type declarations directly:

```bash
find /home/krzysiek/github/Effect-TS/effect-smol/packages -name "*.d.ts" | xargs grep -l "OpenAiClient" 2>/dev/null | head
```

If the local clone is missing, check:

```bash
ls node_modules/@effect/ai-openai-compat/src/ 2>/dev/null
```

Record the findings in a brief comment or scratch note so Step 3 knows which outcome to follow.

**No context7, no web.** Effect v4 is beta.

- [x] **Step 2: Drop the inner cast and explicit return annotation**

In `src/auto-pr/live/ai-provider.ts:37-48`, replace:

```ts
function openAiLanguageModelStack(
	clientOptions: OpenAiClient.Options,
	modelId: string,
	fetchOverrideLayer: Layer.Layer<never>,
): Layer.Layer<LanguageModel.LanguageModel, never> {
	const clientLayer = OpenAiClient.layer(clientOptions).pipe(Layer.provide(FetchHttpClient.layer));
	const modelLayer = OpenAiLanguageModel.model(modelId);
	return Layer.mergeAll(
		fetchOverrideLayer,
		modelLayer.pipe(Layer.provide(clientLayer)),
	) as Layer.Layer<LanguageModel.LanguageModel, never>;
}
```

with:

```ts
function openAiLanguageModelStack(
	clientOptions: OpenAiClient.Options,
	modelId: string,
	fetchOverrideLayer: Layer.Layer<never>,
) {
	const clientLayer = OpenAiClient.layer(clientOptions).pipe(Layer.provide(FetchHttpClient.layer));
	const modelLayer = OpenAiLanguageModel.model(modelId);
	return Layer.mergeAll(fetchOverrideLayer, modelLayer.pipe(Layer.provide(clientLayer)));
}
```

Note: the explicit return annotation AND the trailing `as …` are both deleted. TypeScript infers.

- [x] **Step 3: Run typecheck and handle the inferred type**

```bash
bun run typecheck
```

Read the output. Three outcomes:

**(a) Inferred error is `never`.** No caller complains, no new errors surface. The cast was redundant. Proceed to Step 4.

**(b) Inferred error is a single config-time error** (likely `OpenAiClient.ConfigError` or similar). The outer function `aiProviderLayerFromConfig` declared return type `Layer.Layer<…, AutoPrConfigError>` — its union would widen. Fix by converting inside `openAiLanguageModelStack`:

```ts
function openAiLanguageModelStack(
	clientOptions: OpenAiClient.Options,
	modelId: string,
	fetchOverrideLayer: Layer.Layer<never>,
): Layer.Layer<LanguageModel.LanguageModel, AutoPrConfigError> {
	const clientLayer = OpenAiClient.layer(clientOptions).pipe(Layer.provide(FetchHttpClient.layer));
	const modelLayer = OpenAiLanguageModel.model(modelId);
	return Layer.mergeAll(fetchOverrideLayer, modelLayer.pipe(Layer.provide(clientLayer))).pipe(
		Layer.catchAll((e) =>
			Layer.effect(
				LanguageModel.LanguageModel,
				Effect.fail(
					new AutoPrConfigError({
						missing: [`AI provider layer construction failed: ${String(e)}`],
					}),
				),
			),
		),
	);
}
```

Imports required (at top of file): `AutoPrConfigError` from `#core/errors.js` (already imported); `Effect` and `LanguageModel` (already imported).

**(c) Inferred error is unexpected / multiple.** Stop. Read the inferred type from `tsgo` output carefully. Options:
   i. If the error can be faithfully encoded as `AutoPrConfigError` (a config-time problem), use the (b) approach above with a message that distinguishes the case.
   ii. If the error is genuinely a distinct runtime domain error, add a new tagged error to `src/core/errors.ts` with the full five-point integration (see Task 1, Steps 2-5 pattern). Name it precisely (e.g., `AiLayerConstructionError`).

**Under no circumstance** replace the cast with `as unknown as …`, widen to `Layer.Layer<…, unknown>`, or add `any` anywhere.

- [x] **Step 4: Drop the outer cast**

In `src/auto-pr/live/ai-provider.ts`, locate the end of `aiProviderLayerFromConfig` (around line 96):

```ts
) as Layer.Layer<LanguageModel.LanguageModel, AutoPrConfigError>;
```

Replace with:

```ts
);
```

The declared return type `Layer.Layer<LanguageModel.LanguageModel, AutoPrConfigError>` on the function signature stays. TypeScript verifies inferred matches declared.

If Step 3 outcome was (c) and a new error class was introduced, widen the outer return type:

```ts
): Layer.Layer<LanguageModel.LanguageModel, AutoPrConfigError | AiLayerConstructionError> {
```

- [x] **Step 5: Verify `bun run check:code` passes**

```bash
bun run check:code
```

Expected: exit code 0.

If any existing test was indirectly asserting behaviour that the casts hid, it will fail honestly. Fix the bug revealed, not the cast.

- [x] **Step 6: Commit**

```bash
git add src/auto-pr/live/ai-provider.ts
git commit -m "refactor(ai-provider): remove unsafe Layer.Layer casts; error channel inferred/declared without escape"
```

*(If Step 3(c) added a new tagged error, include `src/core/errors.ts`, `src/auto-pr/errors.ts`, `test/core/errors.test.ts`, `test/auto-pr/errors.test.ts` in the `git add`.)*

### PR B — create the pull request

```bash
gh pr create \
	--title "refactor: remove unsafe Layer casts in AI provider" \
	--body "Implements PR B from docs/superpowers/plans/2026-04-19-effect-hardening.md (Task 3)."
```

---

## PR C — Error shape & config ergonomics

Three tasks, one PR, three commits.

### Task 4: Narrow `Schema.Unknown` causes to `Schema.String`

**Files:**
- Modify: `src/core/errors.ts` lines 57-60 (`ParseError`) and 71-74 (`TemplateRenderError`)
- Modify: `src/auto-pr/errors.ts` lines ~91-92 (`ParseError` format) and ~98-99 (`TemplateRenderError` format)
- Modify: all callers that pass a non-string `cause` (identified by grep)
- Test: `test/auto-pr/errors.test.ts` (add contract test)

- [x] **Step 1: Inventory callers**

Run:

```bash
grep -rn "new ParseError(\|new TemplateRenderError(" src/ test/
```

Record every match. For each, note whether `cause` is already a string. Callers passing `Error` objects or `unknown` will need Step 4's stringify pass.

- [x] **Step 2: Change class definitions**

In `src/core/errors.ts`, change lines 57-60:

```ts
export class ParseError extends Schema.TaggedErrorClass<ParseError>()("ParseError", {
	message: Schema.String,
	cause: Schema.optional(Schema.String),
}) {}
```

Change lines 71-74:

```ts
export class TemplateRenderError extends Schema.TaggedErrorClass<TemplateRenderError>()(
	"TemplateRenderError",
	{ message: Schema.String, cause: Schema.optional(Schema.String) },
) {}
```

- [x] **Step 3: Add failing contract test for `formatError`**

Append to `test/auto-pr/errors.test.ts`:

```ts
import { ParseError } from "#core/errors.js";

test("formatError passes ParseError.cause through as a string", () => {
	const out = formatError(new ParseError({ message: "parse failed", cause: "unexpected token" }));
	expect(out).toContain("parse failed");
	expect(out).toContain("unexpected token");
});
```

Run:

```bash
bun test test/auto-pr/errors.test.ts
```

Expected: PASS (the behaviour is unchanged for string causes; today's `String(cause)` returns the string unchanged).

- [x] **Step 4: Fix each caller**

For every match in Step 1 where `cause` is not already `string`, stringify at the construction site:

```ts
// before
new ParseError({ message: "…", cause: err })
// after
new ParseError({ message: "…", cause: err instanceof Error ? err.message : String(err) })
```

Same pattern for `TemplateRenderError`.

- [x] **Step 5: Simplify `formatError` branches**

In `src/auto-pr/errors.ts`, find the `ParseError` branch (around line 91-92):

```ts
Match.tag("ParseError", ({ message, cause }) =>
	cause == null ? message : `${message}: ${String(cause)}`,
),
```

Replace with (drop `String(…)` — `cause` is now known `string | undefined`):

```ts
Match.tag("ParseError", ({ message, cause }) =>
	cause == null ? message : `${message}: ${cause}`,
),
```

Same for `TemplateRenderError` (around line 98-99).

- [x] **Step 6: Verify `bun run check:code` passes**

```bash
bun run check:code
```

Expected: exit code 0. If `tsgo` flags any caller passing a non-string `cause`, fix per Step 4 and re-run.

- [x] **Step 7: Commit**

```bash
git add src/core/errors.ts src/auto-pr/errors.ts test/auto-pr/errors.test.ts <every-modified-caller-from-Step-1>
git commit -m "refactor(errors): narrow ParseError/TemplateRenderError cause to Schema.String"
```

---

### Task 5: `getOrDefaultLogged` helper for config warn-on-default

**Files:**
- Modify: `src/auto-pr/config.ts` (add helper near existing private helpers around line 50-95; replace 3-5 call sites)

- [x] **Step 1: Inventory call sites**

Run:

```bash
grep -n "Option\.getOrElse\|Option\.isNone\|Effect\.logWarning" src/auto-pr/config.ts
```

Record the line ranges of the warn-on-default triples. Per the audit, there are at least three: around `:178-182`, `:196-204`, `:206-214`, plus equivalents in the `github-models` branch near `:364` and `:421`.

- [x] **Step 2: Add the helper**

In `src/auto-pr/config.ts`, insert near the other private helpers (after `requireRedactedOption` around line 83, or wherever private helpers are grouped):

```ts
/** Unwrap Option with default; log a warning when the default is used. */
function getOrDefaultLogged<T>(
	opt: Option.Option<T>,
	name: string,
	fallback: T,
): Effect.Effect<T, never> {
	return Option.match(opt, {
		onNone: () =>
			Effect.logWarning(`${name} not set, defaulting to ${String(fallback)}`).pipe(
				Effect.as(fallback),
			),
		onSome: Effect.succeed,
	});
}
```

- [x] **Step 3: Replace the first call site (`:178-182`)**

Before:

```ts
const providerRaw = Option.getOrElse(base.aiProvider, () => "");
yield* Option.match(base.aiProvider, {
	onNone: () => Effect.logWarning("AUTO_PR_AI_PROVIDER not set, defaulting to local"),
	onSome: () => Effect.void,
});
const provider = yield* parseProviderOrDefault(providerRaw);
```

After:

```ts
const providerRaw = yield* getOrDefaultLogged(base.aiProvider, "AUTO_PR_AI_PROVIDER", "local");
const provider = yield* parseProviderOrDefault(providerRaw);
```

Note: `parseProviderOrDefault` is kept for now — it handles the case of unknown provider strings. If, after replacing all sites, it's called with a value that's always "local" unless the user explicitly sets it, inline it to `parseProvider`; otherwise leave.

- [x] **Step 4: Replace the `:196-205` call site**

Before:

```ts
const openaiCompatUrl = Option.getOrElse(base.aiOpenaiCompatUrl, () => DEFAULT_OPENAI_COMPAT_URL);
if (Option.isNone(base.aiOpenaiCompatUrl)) {
	yield* Effect.logWarning(
		`AUTO_PR_AI_OPENAI_COMPAT_URL not set, defaulting to ${DEFAULT_OPENAI_COMPAT_URL}`,
	);
}
const url = yield* requireNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_URL", openaiCompatUrl);
```

After:

```ts
const openaiCompatUrl = yield* getOrDefaultLogged(
	base.aiOpenaiCompatUrl,
	"AUTO_PR_AI_OPENAI_COMPAT_URL",
	DEFAULT_OPENAI_COMPAT_URL,
);
const url = yield* requireNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_URL", openaiCompatUrl);
```

- [x] **Step 5: Replace the `:206-215` call site**

Before:

```ts
const model = Option.getOrElse(base.aiOpenaiCompatModel, () => DEFAULT_OPENAI_COMPAT_MODEL);
if (Option.isNone(base.aiOpenaiCompatModel)) {
	yield* Effect.logWarning(
		`AUTO_PR_AI_OPENAI_COMPAT_MODEL not set, defaulting to ${DEFAULT_OPENAI_COMPAT_MODEL}`,
	);
}
const modelId = yield* requireNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_MODEL", model);
```

After:

```ts
const model = yield* getOrDefaultLogged(
	base.aiOpenaiCompatModel,
	"AUTO_PR_AI_OPENAI_COMPAT_MODEL",
	DEFAULT_OPENAI_COMPAT_MODEL,
);
const modelId = yield* requireNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_MODEL", model);
```

- [x] **Step 6: Replace remaining call sites in the `github-models` branch**

Apply the same transform to any equivalent triple in the `github-models` branch (around `:364`, `:421`). The shape is identical — `Option.getOrElse` + `Option.isNone` check + `Effect.logWarning` — just with different env var names.

After this step, a final grep should show zero surviving instances of the `Option.isNone(opt) + Effect.logWarning("...not set, defaulting...")` pattern:

```bash
grep -n "Option\.isNone.*aiOpenai\|Option\.isNone.*aiProvider" src/auto-pr/config.ts
```

Expected output: empty.

- [x] **Step 7: Verify `bun run check:code` passes**

```bash
bun run check:code
```

Expected: exit code 0. `test/auto-pr/config.test.ts` already covers the warn-on-default behaviour; it should continue to pass.

- [x] **Step 8: Commit**

```bash
git add src/auto-pr/config.ts
git commit -m "refactor(config): unify Option-default-warn pattern via getOrDefaultLogged helper"
```

---

### Task 6: Pure `parseOpenAiCompatUrl` + config integration

**Files:**
- Create: `src/core/openai-compat-url.ts`
- Create: `test/core/openai-compat-url.test.ts`
- Modify: `src/auto-pr/config.ts` (integrate after `requireNonEmpty` around `:205`)

- [x] **Step 1: Failing tests for `parseOpenAiCompatUrl`**

Create `test/core/openai-compat-url.test.ts`:

```ts
import { expect, test } from "bun:test";
import { Result } from "effect";
import { parseOpenAiCompatUrl } from "#core/openai-compat-url.js";

test("accepts http://host:port/v1", () => {
	expect(Result.isOk(parseOpenAiCompatUrl("http://127.0.0.1:8080/v1"))).toBe(true);
});

test("accepts https URL", () => {
	expect(Result.isOk(parseOpenAiCompatUrl("https://api.example.com/v1"))).toBe(true);
});

test("rejects empty", () => {
	expect(Result.isErr(parseOpenAiCompatUrl(""))).toBe(true);
});

test("rejects whitespace-only", () => {
	expect(Result.isErr(parseOpenAiCompatUrl("   "))).toBe(true);
});

test("rejects missing scheme", () => {
	expect(Result.isErr(parseOpenAiCompatUrl("localhost:8080"))).toBe(true);
});

test("rejects non-http scheme", () => {
	expect(Result.isErr(parseOpenAiCompatUrl("ftp://example.com/v1"))).toBe(true);
});

test("error carries a human-readable reason", () => {
	const r = parseOpenAiCompatUrl("localhost:8080");
	expect(Result.isErr(r)).toBe(true);
	if (Result.isErr(r)) expect(typeof r.error.reason).toBe("string");
});
```

Run:

```bash
bun test test/core/openai-compat-url.test.ts
```

Expected: FAIL — module missing.

- [x] **Step 2: Create the helper**

Create `src/core/openai-compat-url.ts`:

```ts
import { Result } from "effect";

/** Shape of the error returned by parseOpenAiCompatUrl. Not a tagged error; shell wraps in AutoPrConfigError. */
export interface InvalidOpenAiCompatUrl {
	readonly reason: string;
}

/** Pure: validate OpenAI-compatible base URL (http/https scheme required). */
export function parseOpenAiCompatUrl(raw: string): Result.Result<string, InvalidOpenAiCompatUrl> {
	if (raw.trim() === "") {
		return Result.err({ reason: "empty" });
	}
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return Result.err({ reason: "not a valid URL" });
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return Result.err({ reason: `scheme must be http(s), got ${parsed.protocol}` });
	}
	return Result.ok(raw);
}
```

Run:

```bash
bun test test/core/openai-compat-url.test.ts
```

Expected: PASS (all 7 cases).

- [x] **Step 3: Wire `parseOpenAiCompatUrl` into config**

In `src/auto-pr/config.ts`, locate the line immediately after the `requireNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_URL", …)` call (around `:205` after Task 5's edits). The current code has:

```ts
const url = yield* requireNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_URL", openaiCompatUrl);
```

Replace with:

```ts
const urlRaw = yield* requireNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_URL", openaiCompatUrl);
const url = yield* Effect.fromResult(parseOpenAiCompatUrl(urlRaw)).pipe(
	Effect.mapError(
		(e) => new AutoPrConfigError({ missing: [`AUTO_PR_AI_OPENAI_COMPAT_URL: ${e.reason}`] }),
	),
);
```

Add the import near the top of `src/auto-pr/config.ts`:

```ts
import { parseOpenAiCompatUrl } from "#core/openai-compat-url.js";
```

- [x] **Step 4: Verify `bun run check:code` passes**

```bash
bun run check:code
```

Expected: exit code 0. Config tests continue to pass; valid URLs pass validation; a typo like `localhost:8080` now fails at config load with a precise `AutoPrConfigError` message.

- [x] **Step 5: Commit**

```bash
git add src/core/openai-compat-url.ts test/core/openai-compat-url.test.ts src/auto-pr/config.ts
git commit -m "feat(config): validate AUTO_PR_AI_OPENAI_COMPAT_URL shape, fail early"
```

---

### PR C — create the pull request

```bash
gh pr create \
	--title "refactor: tighten error shapes and config ergonomics" \
	--body "Implements PR C from docs/superpowers/plans/2026-04-19-effect-hardening.md (Tasks 4-6)."
```

---

## Integration: final verification

### Task 7: Full verification across all three PRs

After PRs A, B, C are merged (or all local commits applied on a single branch for a combined review):

- [x] **Step 1: Full gate**

```bash
bun run check
```

Expected: exit code 0, no failures.

- [x] **Step 2: Coverage report**

```bash
bun test --coverage
```

Read the per-file coverage of `src/workflow/auto-pr-create-or-update-pr.ts`. Should be ≥0.80 after Task 1's tests (previously ~0.68).

- [x] **Step 3 (optional): Local act smoke**

```bash
bun run act -- check
```

Useful when landing the combined change — confirms no CI-time regression before hosted run.

- [x] **Step 4: Per AGENTS.md — do not commit `dist/`**

`dist/` is rebuilt by `update-dist.yml` on merge to main. The pre-commit hook (`scripts/check-no-dist-staged.sh`) refuses to stage it.

---

## Self-review

**Spec coverage**

| Spec requirement | Covered by |
|---|---|
| Typed `ghPrViewJson` (§2.1) | Task 1, Steps 2-10 |
| `PullRequestLookupError` five-point integration (§1.1, §2.1, §5) | Task 1, Steps 2-5 |
| `parseFirstJsonObject` reuse (§1.1, §2.1) | Task 1, Step 7 |
| `Schema.decodeUnknownEffect` usage (§1.1, §2.1) | Task 1, Step 7 |
| `Layer.mock(ChildProcessSpawner)` in tests (§1.1, §2.1) | Task 1, Step 6 |
| Pure `parseGhPrCreateOutput` in core (§2.2) | Task 2, Steps 6-7 |
| `PullRequestUrlParseError` five-point integration (§2.2, §5) | Task 2, Steps 2-5 |
| Research existing `Url.fromString` (§2.2, §4.3) | Task 2, Step 1 |
| Shell calls core via `Effect.fromResult` (§1.1) | Task 2, Step 8; Task 6, Step 3 |
| Remove inner Layer cast with outcome a/b/c handling (§3.1) | Task 3, Steps 2-3 |
| Remove outer Layer cast (§3.1) | Task 3, Step 4 |
| No type escapes (`as unknown`, `unknown` widening) (§3.1) | Task 3, Step 3 explicit rigor boundary |
| Narrow `ParseError.cause` (§4.1) | Task 4, Steps 2, 5 |
| Narrow `TemplateRenderError.cause` (§4.1) | Task 4, Steps 2, 5 |
| `getOrDefaultLogged` helper (§4.2) | Task 5, Step 2 |
| Replace all warn-on-default sites (§4.2) | Task 5, Steps 3-6 |
| Pure URL validation (§4.3) | Task 6, Steps 1-2 |
| No new tagged error for URL validation (§1.1, §4.3) | Task 6, Step 2 uses plain `{ reason }` interface |
| `AutoPrConfigError` wraps URL error at shell (§4.3) | Task 6, Step 3 |
| Verification step per task (§1.3) | Each Task's "Verify `bun run check:code` passes" step |
| One commit per task (§1.3) | Each Task's commit step |

No spec requirement is unaddressed.

**Placeholder scan**

All code steps contain concrete code. All test steps contain concrete assertions. All bash commands have expected outputs. Deferred decisions (e.g., whether to reuse `Url.fromString` vs regex in Task 2, whether `parseProviderOrDefault` can be inlined in Task 5, which outcome a/b/c fires in Task 3) are explicit research or branch steps, not "TODO"s — the plan tells the engineer exactly what question to answer and what to do with each answer.

**Type consistency**

- `PullRequestLookupError({ branch, cause })` — consistent across Task 1, Task 2 integration table, Step 5 format test.
- `PullRequestUrlParseError({ raw, reason })` — consistent across Task 2 Steps 2, 3, 5, 7.
- `parseGhPrCreateOutput(stdout): Result<string, PullRequestUrlParseError>` — consistent across Task 2 tests (Step 6) and implementation (Step 7).
- `parseOpenAiCompatUrl(raw): Result<string, InvalidOpenAiCompatUrl>` — consistent across Task 6 tests (Step 1) and implementation (Step 2).
- `getOrDefaultLogged<T>(opt, name, fallback): Effect<T, never>` — consistent across Task 5 Steps 2-5.
- `CreateOrUpdatePrError` gains `PullRequestLookupError` in Task 1 Step 8 and `PullRequestUrlParseError` in Task 2 Step 8 — cumulative, consistent order.
- Five-point integration pattern — used identically for `PullRequestLookupError` (Task 1 Step 4) and `PullRequestUrlParseError` (Task 2 Step 4).

No type drift between tasks.
