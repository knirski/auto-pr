# Functional Core Instructions

These rules apply to `src/core/**`.

`src/core` is the functional core. Keep it pure and easy to test.

## Purity

- No Effect APIs: no `Effect.gen`, `Effect.run*`, `Effect.log`, Layers, Tags, or services.
- No I/O: no filesystem, network, process environment, subprocesses, timers, or external mutable state.
- No shell concerns: do not import from `src/workflow`, `src/tools`, `src/auto-pr/live`, or `src/auto-pr/shell`.

## Data And Errors

- Return plain values for total computations.
- Return `Result` for synchronous validation or parse failures.
- Define domain errors in `src/core/errors.ts` with `Schema.TaggedErrorClass`.
- Format errors outside the core in `src/auto-pr/errors.ts`.
- Use `Option<T>` for optional values and normalize blanks at boundaries when blank should mean absent.

## Tests

- Mirror new core behavior in `test/core/**`.
- Prefer table-style tests for pure branches and edge cases.
- Keep fixtures realistic: helpers should preserve production normalization rules.
