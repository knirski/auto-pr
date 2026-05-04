# Packaged model routing context command

## Context and Problem Statement

The generate reusable workflow runs in adopter repositories through `workflow_call`. The workflow file is pinned to this repository, but the checkout workspace belongs to the adopter. Any repo-owned action used by the reusable workflow runs from `GITHUB_ACTION_PATH`, while `GITHUB_WORKSPACE` points at the adopter repository.

The model routing context logic classifies changed files, commit semantics, diff signals, runner resources, local GGUF sizing risk, and prompt guidance before `auto-pr-generate-content` calls the language model. Those signals select the initial model band, choose tool-use strategy, set local-model defaults for GitHub-hosted runner capacity, and provide structured context that the later language model prompt consumes.

This logic needs TypeScript, Effect, tests, and package dependencies. Keeping a compiled `.mjs` artifact under `.github/actions/**` works, but creates a second distribution mechanism next to the existing package `dist/` output.

## Considered Options

* **Run TypeScript with Bun from a dedicated action** - Keeps source near action metadata, but fails in adopter repositories that never install Bun and still needs dependencies under `GITHUB_ACTION_PATH`.
* **Commit an action-local JavaScript bundle** - Makes a JavaScript action self-contained and portable, but requires committing generated code under `.github/actions/**` and reviewing two runtime artifacts: root `dist/` and the action bundle.
* **Inline the router as shell or workflow YAML** - Maximizes portability, but makes semantic classification, scoring, and summary generation hard to test and review.
* **Package the router as an auto-pr workflow command and invoke it through `auto-pr-run-command`** - Keeps TypeScript source in `src/workflow`, uses the existing package `dist/` path for adopter repos, and uses workspace source on `knirski/auto-pr` branches.

## Decision Outcome

Chosen option: **package model routing context as an auto-pr workflow command**.

### Design details

- The routing command source lives in `src/workflow/auto-pr-build-model-routing-context.ts`.
- The pure routing policy lives beside it in `src/workflow/model-routing.ts`.
- `package.json` exposes `auto-pr-build-model-routing-context` as a bin compiled into root `dist/` by `scripts/build.ts`.
- `.github/actions/auto-pr-run-command` dispatches both `build-model-routing-context` and `generate-content`.
- The reusable generate workflow calls `auto-pr-run-command` for the routing step, so the routing outputs are regular step outputs from that wrapper action.
- On `knirski/auto-pr` branches, `auto-pr-run-command` uses workspace source via `bun run build-model-routing-context` after `bun install`.
- In adopter repositories, `auto-pr-run-command` uses the packaged binary via `npx`/`bunx -p github:knirski/auto-pr`.
- No generated JavaScript is committed under `.github/actions/auto-pr-build-model-routing-context/`; root `dist/` remains the only package runtime artifact and is still owned by the dist update workflows.
- Routing signal semantics are part of the command contract:
  - `sourceChurn` counts only files classified as source.
  - Docs, tests, dependency, generated, and workflow churn remain separate signals.
  - Breaking changes are classified before tiny, docs-only, or generated-only shortcuts.
  - Runner capacity affects local default model selection for the bundled llama.cpp path.
  - The structured signal summary is passed forward as prompt context for `generate-content`.

## Consequences

### Good

- Adopter repositories do not need Bun, package manager metadata, `node_modules`, copied action code, or action-local generated JavaScript.
- The routing logic follows the same distribution model as the other auto-pr workflow commands.
- Root `dist/` remains the only compiled package output; ordinary PRs still do not stage it.
- The reusable workflow keeps a named routing step with explicit outputs.
- Model selection and prompt context use the same measured routing signals.

### Bad

- `auto-pr-run-command` now carries outputs that are meaningful only for `build-model-routing-context`.
- The routing command depends on the package `dist/` update workflow before Node-only GitHub installs from main include the new binary.

### Neutral

- `auto-pr-generate-content` remains the only workflow entrypoint that calls the language model.
- `LanguageModel.generateText` and the JSON Schema decode path remain unchanged.
- Workflow self-reference pin automation still applies when reusable workflow/action wiring changes.

## References

- [Architecture](../ARCHITECTURE.md)
- [CI: workflow pin automation](../CI.md#workflow-pin-automation)
- [CI: dist and .gitignore](../CI.md#dist-and-gitignore)
- [Integration: Step 6](../INTEGRATION.md#step-6-add-the-workflow-file)
