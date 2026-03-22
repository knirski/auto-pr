# Functional Core / Imperative Shell and Effect Architecture

## Context and Problem Statement

auto-pr was extracted from paperless-ingestion-bot and needed a clear separation between pure logic and I/O. The project uses Effect v4 beta for typed error handling and dependency injection. How should we structure the codebase to keep core logic testable without Effect or shell dependencies, while still benefiting from Effect's composability and the Tagless Final pattern?

**Problem:** How do we achieve testability of business logic, clear dependency direction, and idiomatic Effect usage without coupling core to runtime concerns?

## Considered Options

* **Single-layer monolithic** — All logic in workflow scripts with inline I/O. Simple but untestable without mocks; hard to reuse.
* **Service layer with mocks** — Extract services, mock in tests. Common pattern but often leads to integration-heavy tests.
* **Functional Core / Imperative Shell (FC/IS)** — Pure core (`src/lib/*.ts`, `src/auto-pr/core.ts`) returns `Result`; no Effect, no I/O. Shell (`src/auto-pr/shell.ts`) orchestrates I/O and bridges via `Effect.fromResult`. Tagless Final interfaces in `interfaces/`; live interpreters in `live/`.
* **Full Effect throughout** — Use Effect in core. Tighter coupling to Effect; core becomes Effect-specific.

## Decision Outcome

Chosen option: **"Functional Core / Imperative Shell (FC/IS)"**, because it meets testability without runtime (core is pure), keeps dependency direction clean (core does not depend on shell or live), and aligns with Effect's Tagless Final idiom for swapping interpreters. The bridge at the shell boundary (`Effect.fromResult`) keeps core framework-agnostic while the rest of the pipeline uses Effect.

### Consequences

* Good: Core (`core.ts`, `fill-pr-template-core.ts`) is pure — no Effect, no I/O; unit tests run without runtime.
* Good: Shell depends on core; live interpreters implement interfaces. Dependency direction: core ← interfaces ← shell, live.
* Good: Tagless Final (FillPrTemplate, config layers) allows test doubles; production uses `FillPrTemplate.Live`.
* Good: Effect's `Layer` and `Effect.provide` compose cleanly for workflow-specific config and services.
* Minor: Two mental models — Result in core, Effect in shell. Developers must remember the boundary.
* Note: `src/auto-pr/paths.ts` and `config.ts` live in shell layer; they perform resolution/validation but are orchestrated by shell.

## References

* [ARCHITECTURE.md](../ARCHITECTURE.md) — High-level structure, dependency direction
* [ORIGIN.md](../ORIGIN.md) — Extraction from paperless-ingestion-bot
