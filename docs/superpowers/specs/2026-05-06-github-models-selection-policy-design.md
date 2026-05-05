# GitHub Models Selection Policy Improvement

**Date:** 2026-05-06  
**Status:** Proposed  
**Companion specs:** [Dynamic GitHub Models Usage](2026-05-04-dynamic-github-model-usage-design.md), [Inference and routing](2026-03-29-auto-pr-inference-and-routing.md)

## Summary

`github-models` selection should move from a coarse two-model policy to a ranked, constraint-aware selection policy. Today the system starts from one hardcoded default for light PRs and one hardcoded default for heavy PRs, then relies on live catalog fallback to repair capability mismatches. That is workable, but it does not encode a clear quality objective, does not distinguish band B from band A in practice, and does not use request-size feasibility as part of model choice.

The improved policy should:

- Express ranked model preferences per route class instead of a single hardcoded seed.
- Separate policy preference from catalog feasibility.
- Score candidate models explicitly across quality, tool support, envelope fit, and rate-limit generosity.
- Choose the highest-feasible model for the route instead of "whatever static default plus fallback produces."
- Keep Effect/FC-IS boundaries intact: pure selection core, live catalog fetch, workflow orchestration, no model discovery inside generation.

## Current State

Implemented today:

- [src/core/model-routing.ts](../../../src/core/model-routing.ts) derives `band`, `reasoningNeed`, `toolStrategy`, and `requiresToolCalls`.
- GitHub Models initial selection is binary:
  - `openai/gpt-4.1` for band C, high reasoning, or tool-calling routes.
  - `microsoft/phi-4-mini-instruct` otherwise.
- [src/core/github-model-routing.ts](../../../src/core/github-model-routing.ts) repairs the initial selection against the live catalog:
  - keep selected model when it is text-capable and satisfies tool requirements
  - prefer same-tier tool-capable fallback
  - then prefer more generous tool-capable tiers
  - then no-tool fallbacks
- [src/workflow/auto-pr-build-model-routing-context.ts](../../../src/workflow/auto-pr-build-model-routing-context.ts) writes the resolved model and a routed execution envelope to workflow outputs.
- [src/workflow/auto-pr-generate-content.ts](../../../src/workflow/auto-pr-generate-content.ts) consumes the routed model and envelope.

What this gets right:

- deterministic selection
- live catalog awareness
- graceful degradation when tool capability is missing
- conservative execution envelopes

What it gets wrong:

- "best model" is not defined explicitly
- band B has no distinct policy value
- model quality is approximated by one static model choice
- fallback prioritizes tier generosity more strongly than task quality
- request-size feasibility is enforced late, after model choice

## Problem Statement

The current routing policy answers "which broad class of route is this PR?" but not "which GitHub model is best for this route under current constraints?" Those are different questions.

For example:

- A band C route does not necessarily mean `gpt-4.1` is the best available candidate.
- A band A route does not necessarily mean `phi-4-mini-instruct` is the best lightweight candidate.
- A tool-calling route should not pick a preferred model that is likely to reject the request body for the known prompt and tool strategy.
- A stronger candidate should not lose to a weaker one only because the weaker one happens to sit in a more generous tier if both are feasible.

The policy should make these tradeoffs explicit rather than hiding them inside fallback order.

## Goals

- Make GitHub Models selection policy explicit, inspectable, and testable.
- Preserve deterministic behavior when catalog/profile discovery is partially unavailable.
- Introduce meaningful differentiation between route classes, especially band B.
- Prefer the best feasible model for the route, not a single hardcoded default.
- Incorporate request-size feasibility into model choice before inference starts.
- Keep execution envelope routing and model routing aligned.
- Maintain compatibility with existing workflow output contracts where practical.

## Non-Goals

- Changing local model routing policy.
- Implementing provider switching beyond the existing GitHub Models to local fallback behavior.
- Introducing opaque online ranking or adaptive learning.
- Replacing the existing PR banding system.
- Requiring additional paid-only APIs for baseline operation.

## Design Decision

Recommended approach: ranked policy sets per route class plus explicit feasibility filtering and scoring.

Alternatives considered:

| Approach | Result |
|----------|--------|
| Keep two static seed models and refine fallback order | Small patch only. It reduces some bad choices, but the policy remains coarse and under-specified. |
| Use strongest available catalog model for every heavy route | Simple, but too expensive in terms of rate-limit pressure, too brittle for tool/capability mismatches, and too likely to overfit to temporary catalog state. |
| Ranked route-class preferences plus feasibility filtering and scoring | Best fit. It states intent clearly, preserves deterministic behavior, and lets the live catalog constrain rather than define policy. |

## High-Level Policy

Model selection should happen in three phases.

### Phase 1: Route Classification

Keep the current routing inputs:

- `band`
- `reasoningNeed`
- `toolStrategy`
- `requiresToolCalls`
- prompt size estimate
- commit count
- changed file count
- source churn

Convert these into a smaller route class that the model policy can reason about:

```ts
export type GithubModelsRouteClass =
	| "A-text-light"
	| "B-text-medium"
	| "B-tool-medium"
	| "C-text-strong"
	| "C-tool-strong";
```

Mapping:

- band A with `requiresToolCalls=false` -> `A-text-light`
- band B with `requiresToolCalls=false` -> `B-text-medium`
- band B with `requiresToolCalls=true` -> `B-tool-medium`
- band C with `requiresToolCalls=false` -> `C-text-strong`
- band C with `requiresToolCalls=true` -> `C-tool-strong`

If future routing adds additional nuance, route class expansion should be incremental and backward-compatible.

### Phase 2: Policy Preferences

Define ranked candidate preferences per route class. This is pure policy data, not live discovery:

```ts
export type GithubModelsPolicyCandidate = {
	readonly model: string;
	readonly qualityClass: "small" | "medium" | "strong" | "frontier";
	readonly requiresToolCalls: boolean;
};
```

Example policy intent:

- `A-text-light`
  - prefer small, cheap, fast text models
- `B-text-medium`
  - prefer mid-tier text models with stronger quality than A
- `B-tool-medium`
  - prefer tool-capable mid-tier models before escalating to frontier
- `C-text-strong`
  - prefer strongest non-tool text models that fit
- `C-tool-strong`
  - prefer strongest tool-capable models that fit

Important rule:

- The policy may list `gpt-5` in strong route classes if the repository wants that behavior.
- It must not assume `gpt-5` is always present or always feasible.
- "Strongest possible" means strongest within the ranked preference set that is feasible under live constraints.

This makes the answer to "do we start from gpt-5?" a policy choice rather than a hidden implementation artifact.

### Phase 3: Feasibility Filtering And Scoring

Take the ranked preference list and filter/score against live constraints:

- catalog presence
- text output support
- tool-calling support when required
- request envelope fit
- plan and tier limits
- fallback request-size safety

The highest-scoring feasible candidate wins.

## Candidate Scoring

Add a pure scoring layer in [src/core/github-model-routing.ts](../../../src/core/github-model-routing.ts):

```ts
export type GithubModelsCandidateScore = {
	readonly quality: number;
	readonly capabilityFit: number;
	readonly envelopeFit: number;
	readonly tierGenerosity: number;
	readonly total: number;
};
```

Recommended scoring priorities:

1. capability fit
2. envelope fit
3. quality
4. tier generosity

Reasoning:

- A model that cannot support tools for a tool route is not viable.
- A model that is likely to reject the request body is not viable.
- Among viable models, quality should usually dominate generosity.
- Tier generosity matters as a tie-breaker or resilience signal, not as the primary objective.

Feasibility rules:

- Missing catalog entry: candidate is infeasible unless catalog fetch failed entirely.
- No text output: infeasible.
- Tools required but model lacks tool-calling: infeasible.
- Initial request envelope exceeds per-request input/output limits: infeasible.
- If prompt plus minimum completion reserve exceeds safe envelope: infeasible.

## Request-Size Awareness

This is the most important policy improvement beyond explicit preferences.

Current behavior chooses a model and later clamps the envelope. The improved behavior should use the expected envelope as part of selection.

For each candidate:

1. Compute requested envelope from route complexity.
2. Intersect with catalog and plan limits.
3. Estimate safe prompt + tool roundtrip viability.
4. Reject candidates that cannot support the route without immediate request-size failure.

This prevents obvious bad selections like:

- choosing a low-limit tool route candidate for a large prompt when a slightly weaker but feasible candidate exists
- choosing a stronger candidate whose practical per-request cap is too small for the route

## Preference Data Model

Add pure policy data structures:

```ts
export type GithubModelsQualityClass = "small" | "medium" | "strong" | "frontier";

export type GithubModelsRoutePreference = {
	readonly routeClass: GithubModelsRouteClass;
	readonly preferredModels: readonly string[];
	readonly fallbackQualityFloor: GithubModelsQualityClass;
};
```

The exact candidate lists should be centralized in one policy table. That makes future adjustments to `gpt-5`, `gpt-4.1`, `phi-4-mini-instruct`, or other models a policy edit rather than logic surgery.

## Catalog Fallback Behavior

When the preferred policy candidates are not feasible:

1. Try the next preferred candidate in the same route class.
2. If none remain, allow quality-class degradation within the same capability requirements.
3. If still none remain:
   - keep tool requirement for tool routes and search broader tool-capable catalog entries
   - only drop tool requirement if the fallback policy explicitly permits that route downgrade
4. If no feasible GitHub Models candidate remains, preserve the existing provider fallback path.

This is stricter than the current tier-first fallback. It keeps route intent primary.

## Explicit Model Overrides

GitHub Models should continue to ignore explicit model override as the primary selection source in normal workflow policy mode.

However, the improved design should distinguish two modes:

- `policy-managed`
  - current default for workflow execution
  - explicit model does not override policy
- `explicit-model`
  - opt-in for tests, diagnostics, or custom workflows
  - explicit model is tried first, but still validated for capability and envelope fit

This removes ambiguity and makes test fixtures more intentional.

## Band B Improvement

Band B should stop collapsing into "phi unless heavy enough for gpt-4.1."

Band B exists to represent bounded but non-trivial changes. That merits a distinct policy:

- stronger than A for review quality
- cheaper and less rate-limit intensive than C by default
- tool-capable when route strategy requires it

This is the main reason to add route classes rather than direct band-to-model mapping.

## Logging And Observability

Logs should explain why the selected model won.

Add structured diagnostics:

- `route_class`
- `candidate_count`
- `preferred_candidates`
- `rejected_candidates`
- rejection reason per candidate
  - `missing_from_catalog`
  - `missing_tool_capability`
  - `insufficient_input_limit`
  - `insufficient_output_limit`
  - `unsafe_request_size`
- selected candidate score breakdown
- final `selection_mode`

This keeps policy changes reviewable and makes future tuning evidence-based.

## Failure Handling

Selection-time failures:

- catalog unavailable: degrade to deterministic policy fallback
- plan/profile unavailable: treat as `unknown` and use conservative limits
- no feasible candidate: use existing provider fallback path or final primitive fallback as currently designed

Inference-time failures:

- request-size failures should be rare after this change
- if they still occur, classify them as route/model feasibility failures rather than transient transport failures
- retrying the same oversized request should remain forbidden

## Architecture

Preserve current FC/IS boundaries.

### Pure Core

Extend [src/core/github-model-routing.ts](../../../src/core/github-model-routing.ts) with:

- route class derivation
- policy preference table
- candidate scoring
- candidate rejection reasoning
- final candidate selection

### Existing Pure Routing

Leave [src/core/model-routing.ts](../../../src/core/model-routing.ts) responsible for:

- PR complexity signals
- banding
- reasoning need
- tool strategy

It should not own GitHub Models preference ranking beyond producing the route inputs.

### Workflow Orchestration

[src/workflow/auto-pr-build-model-routing-context.ts](../../../src/workflow/auto-pr-build-model-routing-context.ts) should:

- fetch catalog and best-effort plan/profile data
- derive route class from routing decision
- call the new pure selector
- write:
  - selected model
  - selection diagnostics
  - routed envelope

### Generation

[src/workflow/auto-pr-generate-content.ts](../../../src/workflow/auto-pr-generate-content.ts) should continue to consume the routed envelope rather than recompute a looser one.

No model discovery should move into generation.

## Testing Strategy

Pure tests should cover:

- route class derivation
- preferred candidate ordering per route class
- band B differentiation from band A and C
- rejection of non-tool models for tool routes
- rejection of envelope-infeasible candidates
- selection of stronger feasible candidate over weaker more generous-tier candidate
- deterministic fallback when catalog is missing
- explicit-model mode behavior

Workflow tests should cover:

- catalog-based selection with realistic candidate sets
- logged rejection reasons
- propagation of selected model and routed envelope to generation
- no repeated same-attempt retries after request-size failure

## Migration

Suggested implementation order:

1. Add route class and preference data model.
2. Add candidate feasibility and scoring.
3. Replace current catalog fallback ordering with scored candidate selection.
4. Add structured diagnostics.
5. Update tests and workflow fixtures.

This order preserves behavior while allowing incremental review.

## Open Questions Resolved In This Spec

### Should GitHub Models start from the strongest available model, such as `gpt-5`?

Not unconditionally.

The policy should start from the strongest preferred candidate for the route class that is feasible under live constraints. If the repository wants `gpt-5` as the top strong-route candidate, it belongs at the top of the `C-text-strong` and/or `C-tool-strong` preference list. It should still lose when infeasible.

### Should tier generosity dominate model quality?

No.

Tier generosity is an operational constraint and tie-breaker, not the primary quality objective.

### Should request-size fit be part of selection?

Yes.

It should be a hard feasibility gate, not just a post-selection clamp.

## Recommendation

Adopt ranked route-class preferences plus feasibility filtering and explicit scoring.

That keeps the system deterministic, improves model quality choices, makes band B meaningful, and closes the policy gap between routing intent and actual GitHub Models selection.
