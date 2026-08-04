# Effect Idiom & Type-Safety Hardening (Design)

**Date:** 2026-04-19
**Scope:** Six targeted edits across `src/workflow/auto-pr-create-or-update-pr.ts`, `src/auto-pr/live/ai-provider.ts`, `src/core/errors.ts`, and `src/auto-pr/config.ts`. Three logical PRs. Supersedes the earlier `docs/superpowers/plans/2026-04-19-effect-hardening.md`, which was written without full project-idiom context and reinvented helpers that already exist.
**Goal:** Tighten type safety and FC/IS rigor in the PR-writing hot path and the AI provider layer, without broadening scope. Every change uses existing project idioms (`parseFirstJsonObject`, `Layer.mock(ChildProcessSpawner)`, `Schema.decodeUnknownEffect`, `AutoPrConfigError`); no new abstractions that don't earn their keep.

---

## 1. Architecture & principles

### 1.1 Hard constraints (non-negotiable)

- **FC/IS rigor** — core (`src/core/*-core.ts` and `src/core/*.ts` per `.cursor/rules/core-purity.mdc`) stays pure: no Effect, no I/O, no `@effect/*` imports beyond data types (`Result`, `Option`, `Schema`). New pure helpers (`parseGhPrCreateOutput`, `parseOpenAiCompatUrl`) live in `src/core/` and return `Result<T, E>`. Shell bridges via `Effect.fromResult`. Tagged error classes are defined in `src/core/errors.ts` only.
- **Type-safe FP** — no `any`, no `as X`, no `!`, no `enum`. Error channels are precise unions of tagged errors or plain `Error`; never `unknown`. `Match.exhaustive` on every ADT match. `Option<T>` only for genuinely optional values. Required config fields never use `Option` (per `ts-scripting.mdc`).
- **Reuse over reinvention** — `parseFirstJsonObject` (`src/core/parse-model-json.ts`) for JSON parsing; `Layer.mock(ChildProcessSpawner)(…)` (`test/test-utils.ts` — see `ChildProcessSpawnerTestMock`, `ChildProcessSpawnerCreatePathMock`, `ChildProcessSpawnerUpdatePathMock`) for spawner mocks; `Schema.decodeUnknownEffect` for schema decoding; `AutoPrConfigError` for all config-validation errors. No new tagged error class unless no existing class fits.
- **Integration-point discipline** — every new tagged error touches exactly five places (the plan will enumerate each explicitly):
  1. Define in `src/core/errors.ts`.
  2. Import in `src/auto-pr/errors.ts`.
  3. Re-export from `src/auto-pr/errors.ts`.
  4. Add to the `instanceof` guard chain in `formatError` (`src/auto-pr/errors.ts:52-64`).
  5. Add `Match.tag(…)` branch before `Match.exhaustive`.

  Sixth integration (`isTransientAiError`) applies only to errors arising from AI provider calls — not applicable to any error in this spec.

### 1.2 Research rule for Effect v4 uncertainty

Effect v4 is still in beta; third-party docs lag. When any task needs an Effect v4 API signature confirmed, consult in this order:

1. **Primary:** `https://github.com/Effect-TS/effect/blob/main/LLMS.md` (local clone at `/home/krzysiek/github/Effect-TS/effect/LLMS.md`).
2. **Secondary:** the `effect` source tree itself (`packages/ai-openai-compat/`, `packages/platform/`, etc.) for type declarations LLMS.md doesn't cover.
3. **Tertiary (only if above silent):** context7, then web. Both can be stale for beta APIs.

### 1.3 Per-task rigor

- **Research step** (where applicable, recorded as a plan step, not an afterthought) — primarily Task 3 (Layer types), secondarily Task 6 (verify `Url.fromString` suitability).
- **Verification step per task** — `bun run check:code` after implementation, read output, then commit. Per `.cursor/rules/verification.mdc`: evidence before claims.
- **One commit per task** — Conventional format with scope matching the primary file (`refactor(workflow)`, `refactor(core)`, `refactor(ai-provider)`, `refactor(errors)`, `refactor(config)`, `feat(config)`). Per `.cursor/rules/commit-messages.mdc`: frequent commits, one per logical step.

### 1.4 Out of scope / deferred

Explicitly deferred to separate specs rather than shoehorned in:

- **`collapseProseParagraphs` Result reshape.** Silent fallback at `src/core/collapse-prose-paragraphs.ts:55-56`. Callers flow through `Result`-returning `renderBody` in `fill-pr-template-core.ts`; propagating `usedFallback` touches several Result payloads. Cross-cutting enough to warrant its own spec when silent corruption is actually observed.
- **`InvalidOpenAiCompatUrlError` as a new tagged class.** Rejected in favour of `AutoPrConfigError` with a specific `missing[]` message, which is the codebase's idiom for all config-validation errors.
- **Coverage-threshold bump** (currently 0.68 in `bunfig.toml`). Not a standalone task; rides along when Task 1's new tests lift real file coverage above the floor.
- **AI latency telemetry, PR create/edit race, timeout vs. connection error taxonomy, `Redacted` unwrap discipline.** Each is its own concern; the existing `2026-04-07-error-handling-resilience.md` spec partially covers the third.

---

## 2. PR A — PR-lifecycle correctness (Tasks 1 + 2)

Shared scope: `src/workflow/auto-pr-create-or-update-pr.ts`. Two commits, one PR.

### 2.1 Task 1 — typed `ghPrViewJson`

**Problem.** `auto-pr-create-or-update-pr.ts:40-59` has three nested `Effect.catch(() => Effect.succeed(Option.none()))` chains that collapse "PR doesn't exist," "gh CLI/network failure," and "schema drift" into the same `Option.none()`. Consumers cannot distinguish.

**Design.**

- **New tagged error** `PullRequestLookupError` in `src/core/errors.ts`:

  ```ts
  /** `gh pr view` failed or returned unparseable JSON. Distinct from "no PR yet" (Option.none). */
  export class PullRequestLookupError extends Schema.TaggedErrorClass<PullRequestLookupError>()(
    "PullRequestLookupError",
    { branch: Schema.String, cause: Schema.String },
  ) {}
  ```

  Five integration points per §1.1.

- **New signature** for `ghPrViewJson`:

  ```ts
  Effect.Effect<Option.Option<PullRequestInfo>, PullRequestLookupError, ChildProcessSpawner>
  ```

  `Option.none()` means "no PR exists" and nothing else. Every other failure is `Fail(PullRequestLookupError)`.

- **"No PR exists" detection.** `runCommand` returns `Effect<string, PullRequestFailedError, ChildProcessSpawner>` today. Wrap with `Effect.catchTag("PullRequestFailedError", …)`: if `e.cause` contains "no pull requests found" (case-insensitive substring — `gh`-version-tolerant), resolve to empty string (downstream `Option.none()`); otherwise map to `PullRequestLookupError`. The exact error string is verified during implementation against real `gh` output on a branch with no PR.

- **JSON parsing** uses `parseFirstJsonObject` from `src/core/parse-model-json.ts` — bridged via `Effect.fromResult`, errors mapped to `PullRequestLookupError`. No bespoke `Effect.try(JSON.parse)`.

- **Schema decoding** uses `Schema.decodeUnknownEffect(PullRequestInfoSchema)` (the project's existing choice; `Schema.decodeUnknownOption` is wrong here because we want failure to surface, not collapse to `Option.none()`).

- **Caller update.** `CreateOrUpdatePrError` at `:133` gains `PullRequestLookupError`. TypeScript enforces via `tsgo`; any missing `formatError` branch fails compilation.

**Tests.** Append to `test/workflow/create-or-update-pr.test.ts` (**already exists**). Use `Layer.mock(ChildProcessSpawner)(…)` following the existing `ChildProcessSpawnerTestMock` / `ChildProcessSpawnerCreatePathMock` / `ChildProcessSpawnerUpdatePathMock` pattern in `test/test-utils.ts` — do not invent a new mock builder. Cases:

- empty stdout → `Option.none`
- valid JSON matching `PullRequestInfoSchema` → `Option.some(…)`
- malformed JSON → `Fail(PullRequestLookupError)`
- `gh` "no pull requests found" error → `Option.none`
- other `gh` error (e.g., auth) → `Fail(PullRequestLookupError)`
- schema mismatch (wrong shape) → `Fail(PullRequestLookupError)`

**Commit.** `refactor(workflow): typed PullRequestLookupError instead of silent catch in ghPrViewJson`.

### 2.2 Task 2 — pure `parseGhPrCreateOutput`

**Problem.** `extractPrUrl` at `auto-pr-create-or-update-pr.ts:129-131` does `stdout.trim().split("\n").at(-1) ?? ""`. Silent `""` on malformed output. The function is in the shell but has no I/O — it's a pure string function masquerading as shell code.

**Design.**

- **Move to `src/core/gh-pr-url.ts`** as a pure function:

  ```ts
  export function parseGhPrCreateOutput(
    stdout: string,
  ): Result.Result<string, PullRequestUrlParseError>
  ```

  Returns the last non-empty line, validated as a GitHub PR URL.

- **New tagged error** `PullRequestUrlParseError` in `src/core/errors.ts`:

  ```ts
  /** `gh pr create` output could not be parsed into a PR URL. */
  export class PullRequestUrlParseError extends Schema.TaggedErrorClass<PullRequestUrlParseError>()(
    "PullRequestUrlParseError",
    { raw: Schema.String, reason: Schema.String },
  ) {}
  ```

  Five integration points.

- **URL validation.** Prefer reuse: check whether the existing `Url.fromString(…)` helper (used at `src/tools/auto-pr-init.ts:34`) accepts arbitrary http(s) URLs and returns `Result<URL, E>`. If yes, use it inside `parseGhPrCreateOutput` and additionally verify the path matches `/pull/<digits>$`. If it's too narrow (e.g., only `import.meta.url`-style parsing), fall back to a regex (`/^https?:\/\/\S+\/pull\/\d+$/`) with a one-line comment justifying why reuse was rejected. Plan records the decision during implementation.

- **Shell integration.** `src/workflow/auto-pr-create-or-update-pr.ts` deletes `extractPrUrl` (`:129-131`), imports `parseGhPrCreateOutput` via `#core/gh-pr-url.js` (or `#core/index.js` if re-exported), and calls via `Effect.fromResult`. `CreateOrUpdatePrError` gains `PullRequestUrlParseError`.

**Tests.** New `test/core/gh-pr-url.test.ts` — pure-function tests, no Layers. Cases:

- single-line URL → `Result.ok(url)`
- multi-line gh output ending with URL → `Result.ok(url)` (last line)
- empty / whitespace-only → `Result.err(…)`
- last line not a URL → `Result.err(…)`
- leading/trailing whitespace on URL line → handled (trimmed before regex/URL parse)

**Commit.** `refactor(core): pure parseGhPrCreateOutput with Result and URL shape validation`.

### 2.3 PR A assembly

- **One PR, two commits** (Task 1 → Task 2 order).
- Verification: `bun run check:code` passes after each commit.
- Coverage of `auto-pr-create-or-update-pr.ts` rises (currently ~0.68 per `bunfig.toml`). If the new coverage exceeds the repo threshold, bump `bunfig.toml` as a ride-along in this PR.

---

## 3. PR B — AI provider Layer type safety (Task 3)

### 3.1 Task 3 — remove both `as Layer.Layer<…>` casts

**Problem.** `src/auto-pr/live/ai-provider.ts` has two casts:

- **Line 47** inside `openAiLanguageModelStack`:

  ```ts
  return Layer.mergeAll(
    fetchOverrideLayer,
    modelLayer.pipe(Layer.provide(clientLayer)),
  ) as Layer.Layer<LanguageModel.LanguageModel, never>;
  ```

- **Line 96** at the tail of `aiProviderLayerFromConfig`:

  ```ts
  ) as Layer.Layer<LanguageModel.LanguageModel, AutoPrConfigError>;
  ```

Both assert the inferred type matches the declared shape without evidence. `Match.exhaustive` above the outer cast cannot carry totality through an `as`. If Effect v4 beta's real error type for `OpenAiClient.layer(...)` is non-`never`, the cast is silently unsound.

**Design.**

1. **Research step (mandatory).** Consult `effect/LLMS.md` for the return-type shape of `OpenAiClient.layer(options)`, error-channel behaviour of `Layer.provide`, and how `Layer.mergeAll` unions error channels. If LLMS.md is silent on any of these, read type declarations directly in `effect/packages/ai-openai-compat/`. No context7, no web.
2. **Drop the inner cast** and the explicit `: Layer.Layer<LanguageModel.LanguageModel, never>` return annotation on `openAiLanguageModelStack`. Let TypeScript infer. Run `bun run typecheck` and read the compiler output.
3. **Handle the inferred type:**
   - **(a) Inferred error is `never`.** Cast was redundant; proceed.
   - **(b) Inferred error is a single config-time error** (e.g., `OpenAiClient.ConfigError` from `Layer` construction). Convert to `AutoPrConfigError` inside the function via `Layer.catchAll(e => Layer.effect(LanguageModel.LanguageModel, Effect.fail(new AutoPrConfigError({ missing: [e.message] }))))` — matches the github-models branch's existing pattern. Declare return type explicitly as `Layer.Layer<LanguageModel.LanguageModel, AutoPrConfigError>`.
   - **(c) Inferred error is unexpected or multiple.** Stop and reassess. If a genuinely new error class is required to carry an irreducible error type, add it with the full five-point integration — an explicit exception to §1.1's "no new error class unless no existing class fits" and allowed here because type safety > convention.
4. **Drop the outer cast.** Declared return type `Layer.Layer<LanguageModel.LanguageModel, AutoPrConfigError>` stays. TypeScript verifies inferred matches declared. If (a) or (b) in step 3, this is trivial. If (c), widen the outer type to include the new error.
5. **Verification.** `bun run check:code` passes.

**Rigor boundary.** Under no circumstance does this task replace a removed cast with `as unknown as …`, `Layer.Layer<…, unknown>`, or any other type escape. If the types genuinely cannot be reconciled, the escape is **a new tagged error**, not widening to `unknown`.

**Tests.** No new tests. Type-level change. Existing unit and integration tests must continue to pass — any test that was indirectly asserting behaviour the casts were hiding fails honestly, which is the point.

**Commit.** `refactor(ai-provider): remove unsafe Layer.Layer casts; error channel inferred/declared without escape`. One commit — the outer cast depends on the inner's inferred shape; splitting creates an intermediate state where the outer is still load-bearing.

**Risk.** If Effect v4 beta changes `OpenAiClient.layer`'s signature between planning and execution, re-consult LLMS.md. The plan's "outcomes a/b/c" branching is the mitigation.

### 3.2 PR B assembly

- One PR, one commit, no new tests.
- Verification: full `bun run check:code`; integration test (run locally or in CI) exercises the AI provider end-to-end.

---

## 4. PR C — Error shape & config ergonomics (Tasks 4 + 5 + 6)

Three independent edits, one PR, three commits.

### 4.1 Task 4 — narrow `Schema.Unknown` causes

**Problem.** `src/core/errors.ts:59` (`ParseError.cause`) and `:73` (`TemplateRenderError.cause`) declare `Schema.optional(Schema.Unknown)`. `Schema.Unknown` defeats pattern-matching. Existing `formatError` branches (`auto-pr/errors.ts:91-92, 98-99`) already stringify via `String(cause)`, confirming every caller passes something stringifiable.

**Design.**

- Change class definitions in `src/core/errors.ts`:

  ```ts
  export class ParseError extends Schema.TaggedErrorClass<ParseError>()("ParseError", {
    message: Schema.String,
    cause: Schema.optional(Schema.String),
  }) {}

  export class TemplateRenderError extends Schema.TaggedErrorClass<TemplateRenderError>()(
    "TemplateRenderError",
    { message: Schema.String, cause: Schema.optional(Schema.String) },
  ) {}
  ```

- **Sweep callers** — grep `new (ParseError|TemplateRenderError)\(` across the repo. At each construction site, stringify if not already: `cause: e instanceof Error ? e.message : String(e)`. `tsgo` flags any missed caller.
- **Simplify `formatError`** at `auto-pr/errors.ts:91-92, 98-99`. `String(cause)` is no longer needed because `cause` is already `string | undefined`:

  ```ts
  Match.tag("ParseError", ({ message, cause }) =>
    cause == null ? message : `${message}: ${cause}`,
  ),
  ```

  Same for `TemplateRenderError`. Include this cleanup in the same commit so the diff tells a complete story.

**Tests.** Existing tests continue to pass. Add one assertion to `test/auto-pr/errors.test.ts` confirming `ParseError.cause` flows through `formatError` as a string — documents the new contract.

**FC/IS compliance.** Errors stay in `src/core/errors.ts`. Caller sweep may touch shell files at construction only; no behavioural change.

**Commit.** `refactor(errors): narrow ParseError/TemplateRenderError cause to Schema.String`.

### 4.2 Task 5 — unify config warn-on-default pattern

**Problem.** `src/auto-pr/config.ts:178-182`, `:196-204`, `:206-214` (and near `:364`, `:421` in the github-models branch) all follow the shape:

```ts
const v = Option.getOrElse(opt, () => DEFAULT);
if (Option.isNone(opt)) { yield* Effect.logWarning(`${name} not set, defaulting to ${DEFAULT}`); }
```

Two traversals of the same `Option`, repeated 3-5 times.

**Design.**

- **New private helper** at the top of `src/auto-pr/config.ts` (shell, not core — uses `Effect.logWarning`):

  ```ts
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

- **Replace each call site.** Grep all matching triples; rewrite to `yield* getOrDefaultLogged(...)`. If `parseProviderOrDefault` becomes thin after the rewrite (only one caller uses the default behaviour), inline it; otherwise keep. Decision recorded during implementation.

**Tests.** `test/auto-pr/config.test.ts` already covers the warn-on-default behaviour. No new tests; run existing to verify.

**FC/IS compliance.** Helper is shell. Does not cross into core.

**Commit.** `refactor(config): unify Option-default-warn pattern via getOrDefaultLogged helper`.

### 4.3 Task 6 — pure URL validation for `AUTO_PR_AI_OPENAI_COMPAT_URL`

**Problem.** `src/auto-pr/config.ts:205` validates only non-emptiness. Typos like `localhost:8080` (no scheme) pass config and fail at the first AI call with an opaque network error.

**Design.**

- **Research step.** Check whether `Url.fromString(...)` (used at `src/tools/auto-pr-init.ts:34`) accepts arbitrary http(s) URLs and returns `Result<URL, E>`. Consult `effect/LLMS.md` first; fall back to source at `effect/packages/*`. If suitable, reuse inside the helper below. If not, document why and fall back to a `new URL(...)` try/catch with explicit scheme check.
- **Pure helper** in `src/core/openai-compat-url.ts`:

  ```ts
  export function parseOpenAiCompatUrl(
    raw: string,
  ): Result.Result<string, { readonly reason: string }>
  ```

  Accepts: non-empty, `http:` or `https:` scheme only. Returns: validated string on success; `Result.err({ reason: "…" })` on failure. **No new tagged error class** — error type is a plain object, consistent with `src/core/parse-model-json.ts` and `src/core/gh-output.ts` which use `Result<T, Error>` for non-domain validation.

- **Shell integration** in `src/auto-pr/config.ts`, immediately after the existing `requireNonEmpty` at `:205`:

  ```ts
  const urlRaw = yield* requireNonEmpty("AUTO_PR_AI_OPENAI_COMPAT_URL", openaiCompatUrl);
  const url = yield* Effect.fromResult(parseOpenAiCompatUrl(urlRaw)).pipe(
    Effect.mapError((e) => new AutoPrConfigError({
      missing: [`AUTO_PR_AI_OPENAI_COMPAT_URL: ${e.reason}`],
    })),
  );
  ```

  Config-loader error channel stays at `AutoPrConfigError` exclusively. No five-point integration overhead.

**Tests.** New `test/core/openai-compat-url.test.ts` — pure unit tests. Cases: `http://127.0.0.1:8080/v1`, `https://api.example.com/v1`, empty, whitespace-only, missing scheme (`localhost:8080`), non-http scheme (`ftp://…`).

**FC/IS compliance.** New helper is pure. Shell bridges via `Effect.fromResult`. Textbook.

**Commit.** `feat(config): validate AUTO_PR_AI_OPENAI_COMPAT_URL shape, fail early`.

### 4.4 PR C assembly

- One PR, three commits (Task 4 → 5 → 6).
- Verification: `bun run check:code` after each commit.

---

## 5. Integration points checklist

Tracks the five-point integration for every new tagged error, so the plan author never misses a step.

| Error | `src/core/errors.ts` | `src/auto-pr/errors.ts` import | re-export | `instanceof` guard | `Match.tag` branch |
|---|---|---|---|---|---|
| `PullRequestLookupError` (Task 1) | ✔ define | ✔ import | ✔ re-export | ✔ guard | ✔ `Match.tag("PullRequestLookupError", ({ branch, cause }) => \`PR lookup failed (\${branch}): \${cause}\`)` |
| `PullRequestUrlParseError` (Task 2) | ✔ define | ✔ import | ✔ re-export | ✔ guard | ✔ `Match.tag("PullRequestUrlParseError", ({ raw, reason }) => \`gh PR URL parse failed (\${reason}). Raw: \${raw.slice(0, 200)}\`)` |

No error from this spec arises from AI provider calls, so `isTransientAiError` is not touched.

If Task 3 outcome (c) fires (§3.1) and a new tagged error must be introduced to carry an irreducible Effect v4 error type, it inherits the same five-point integration obligation. The plan's Task 3 step explicitly checks for this.

---

## 6. Sequencing & out-of-scope

**PR order (suggested).** PR A → PR C → PR B. PR A and PR C are mechanical / low-risk and give fast feedback. PR B has the highest type-system uncertainty (Effect v4 beta) and benefits from landing the simpler PRs first so its diff is isolated. Any other order works; no hard dependencies between PRs.

**Each PR is independently revertable.** No cross-PR code dependencies.

**Deferred (per §1.4).** `collapseProseParagraphs` Result reshape; `InvalidOpenAiCompatUrlError` as its own class; coverage-threshold bump as a standalone task; AI latency telemetry; PR create/edit race; timeout vs. connection error taxonomy; `Redacted` unwrap discipline.

---

## 7. Success criteria

Implementation is complete when:

- **PR A:** `PullRequestLookupError` and `PullRequestUrlParseError` exist with five-point integration; `ghPrViewJson` has precise error channel; `extractPrUrl` deleted; `parseGhPrCreateOutput` exists in `src/core/gh-pr-url.ts`; new tests in `test/workflow/create-or-update-pr.test.ts` (appended) and `test/core/gh-pr-url.test.ts` (new) all pass; `CreateOrUpdatePrError` includes both new errors.
- **PR B:** Both `as Layer.Layer<…>` casts removed from `ai-provider.ts`; inferred error channel honoured per outcome (a/b/c from §3.1); no `as`, `as unknown as`, or widening to `unknown` introduced; all tests pass.
- **PR C:** `ParseError.cause` and `TemplateRenderError.cause` are `Schema.optional(Schema.String)`; every caller passes a string; `getOrDefaultLogged` helper in use at all three (or five) call sites in `config.ts`; `parseOpenAiCompatUrl` validates `http(s)` URLs and the config loader fails loudly with `AutoPrConfigError` on typos.
- **Repo-wide:** `bun run check:code` passes; coverage does not regress; no new type escapes (`any`, `as unknown`, `!`, `enum`); `.cursor/rules/` conventions all honoured.
