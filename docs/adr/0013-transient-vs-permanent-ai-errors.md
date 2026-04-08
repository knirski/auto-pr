# Transient vs permanent AI error classification

## Context and Problem Statement

`generate-content` retries AI generation and falls back to a commit-derived description when generation fails. Not all failures are worth retrying or hiding behind a generic fallback: a 401 Unauthorized means the API key is wrong — retrying wastes time and the fallback silently masks a configuration problem the user needs to fix.

Before this decision, all AI failures were treated uniformly: they either triggered retries or the fallback path, and none surfaced directly as user-visible configuration errors.

## Considered Options

* **Treat all AI failures as transient** — Simple. Every failure retries and falls back. User never sees an auth error directly; they get a commit-derived description with no indication of why AI generation failed.
* **Treat all AI failures as permanent** — Conservative. Every failure surfaces as an error. Safe for auth errors but breaks the fallback path for network blips and rate limits.
* **Classify by HTTP status or error reason** — Inspect the failure type and route accordingly: permanent failures surface as `AutoPrConfigError`; transient failures continue to the fallback.

## Decision Outcome

Chosen option: **classify by HTTP status or error reason**, via `isTransientAiError` in `src/auto-pr/errors.ts`.

### Classification rules

| Error type | Condition | Classification |
|------------|-----------|----------------|
| `AiProviderError` | status 401 or 403 | **Permanent** — bad credentials or auth config |
| `AiProviderError` | status null, 429, 5xx, or other 4xx | **Transient** — network, rate limit, server error |
| `AiError` (Effect AI) | reason `AuthenticationError` | **Permanent** — invalid API key |
| `AiError` (Effect AI) | any other reason (including `InvalidRequestError`) | **Transient** |
| `DescriptionParseError` | — | **Transient** — schema decode failure; retry may succeed with a different model output |
| Anything else | — | **Transient** — unknown errors default to transient |

`InvalidRequestError` (HTTP 400) is classified as transient even though it is technically a client error. Local llama.cpp servers can return 400 for model-limitation reasons (e.g. context overflow on a specific prompt) that may not reproduce on retry or that the fallback path handles fine. Treating it as permanent would break the fallback for local model users.

### Consequences

* **Good:** Auth errors surface immediately as `AutoPrConfigError`, naming the problem. Users don't see a commit-derived description and wonder why AI generation silently failed.
* **Good:** Transient errors (network, rate limit, server errors) continue to the existing retry-then-fallback path — no regression for those cases.
* **Good:** `isTransientAiError` is a pure function and is straightforwardly tested.
* **Neutral:** The classification logic has to be kept in sync with new `AiError` reason types as Effect AI evolves. The default-to-transient fallback (`return true` at the end) is intentionally conservative.

## References

* Implementation: `src/auto-pr/errors.ts` (`isTransientAiError`), `src/workflow/auto-pr-generate-content.ts` (`catchTags` for `AiError`)
* Related: [ADR 0007](0007-ai-abstraction-layer.md) (AI provider abstraction), [ADR 0011](0011-gitcontext-and-diff-tool-use.md) (DiffToolkit and GitContext)
