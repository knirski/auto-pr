# Model Routing Context Renaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the model-routing action to reflect that it builds prompt context, and refactor the wrapper/test to use Effect idioms while preserving the band, selected model, and signal summary outputs.

**Architecture:** Keep the banding policy in `src/core/model-band.ts` as the pure source of truth. Rename the composite action and its script to describe the actual responsibility: collecting signals, resolving the routing decision, and emitting a context summary that will be passed into the later LLM prompt. Move the action wrapper and test onto `Effect.gen`/`Effect.try` style so the executable flow matches the rest of the codebase.

**Tech Stack:** TypeScript, Effect v4, Bun tests, GitHub composite actions, Git workflow pinning.

---

## Task 1: Rename the routing action to match its prompt-context responsibility

**Files:**
- Modify: `.github/actions/auto-pr-build-model-routing-context/action.yml`
- Modify: `.github/workflows/auto-pr-generate-reusable.yml:120-181`

- [ ] **Step 1: Update the failing reference points**

```yaml
# .github/actions/auto-pr-select-model-band/action.yml
name: Build model routing context
description: >-
  Collects diff signals, resolves the model band, and emits routing context for the LLM prompt.
```

```yaml
# .github/workflows/auto-pr-generate-reusable.yml
- name: Build model routing context
  id: ai_routing
  uses: knirski/auto-pr/.github/actions/auto-pr-build-model-routing-context@the branch's current self-pin SHA
```

- [ ] **Step 2: Rename the action directory and update the workflow path**

Run: `git mv .github/actions/auto-pr-select-model-band .github/actions/auto-pr-build-model-routing-context`

Expected: the composite action path and wrapper file names now match the new responsibility.

- [ ] **Step 3: Verify the workflow still references the renamed action**

Run: `rg -n "auto-pr-select-model-band|auto-pr-build-model-routing-context" .github/workflows .github/actions`

Expected: no remaining workflow references to the old action path.

- [ ] **Step 4: Commit the rename**

```bash
git add .github/actions/auto-pr-build-model-routing-context .github/workflows/auto-pr-generate-reusable.yml
git commit -m "refactor(workflows): rename model routing context action"
```

## Task 2: Refactor the action wrapper and test to Effect style

**Files:**
- Modify: `.github/actions/auto-pr-build-model-routing-context/auto-pr-build-model-routing-context.ts`
- Modify: `test/scripts/auto-pr-build-model-routing-context.test.ts`
- Modify: `src/core/model-band.ts` only if a small helper is needed for richer signal-summary text

- [ ] **Step 1: Write the failing Effect-style test**

```ts
test("build-model-routing-context emits band, selected model, and routing context summary", async () => {
  const exit = await runEffect(TestBaseLayer)(
    Effect.gen(function* () {
      // create temp repo, run the action program, read GITHUB_OUTPUT
    }).pipe(Effect.scoped),
  );

  expect(exit).toBeDefined();
});
```

- [ ] **Step 2: Run the test and confirm the old wrapper shape fails**

Run: `bun test test/scripts/auto-pr-build-model-routing-context.test.ts`

Expected: fail until the renamed wrapper exports an Effect program and writes the new output content.

- [ ] **Step 3: Implement the minimal Effect-based wrapper**

```ts
const program = Effect.gen(function* () {
  const workspace = yield* readRequiredEnv("WORKSPACE");
  const defaultBranch = yield* readRequiredEnv("DEFAULT_BRANCH");
  const provider = yield* readRequiredEnv("AI_PROVIDER");
  const githubOutput = yield* readRequiredEnv("GITHUB_OUTPUT");
  const signals = yield* collectSignals(workspace, defaultBranch);
  const decision = resolveModelBand({ provider, explicitModel, signals });
  yield* writeGhOutput(githubOutput, decision);
});
```

- [ ] **Step 4: Run the test again and confirm it passes**

Run: `bun test test/scripts/auto-pr-build-model-routing-context.test.ts`

Expected: PASS with the wrapper producing `selected_model`, `routing_context`, and `band`.

- [ ] **Step 5: Commit the implementation**

```bash
git add .github/actions/auto-pr-build-model-routing-context/auto-pr-build-model-routing-context.ts test/scripts/auto-pr-build-model-routing-context.test.ts src/core/model-band.ts
git commit -m "refactor(workflows): make routing action Effect-based"
```

## Task 3: Verify the full branch

**Files:**
- No new files

- [ ] **Step 1: Run the project check gate**

Run: `bun run check`

Expected: exit 0, with lint, typecheck, and tests all passing.

- [ ] **Step 2: Inspect the diff for accidental churn**

Run: `git diff --stat`

Expected: only the renamed routing action, its test, the workflow reference update, and the core helper changes needed for the new summary output.

- [ ] **Step 3: Commit any final cleanup**

```bash
git add -A
git commit -m "refactor(workflows): rename and effect-ify routing context action"
```
