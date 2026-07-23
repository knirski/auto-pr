# Repository Remediation Implementation Plan

**Date:** 2026-07-23
**Status:** Proposed
**Source:** Repository assessment performed against `main` at
`6c4fcae03d2eaaa99d3ec9abe1124926adf6afab`.

> **For implementers:** Execute this plan in order. Use the repository's
> Superpowers skills when available: brainstorming for any design deviation,
> writing-plans before splitting this document, using-git-worktrees for each
> branch, test-driven-development for code changes, systematic-debugging for
> failures, verification-before-completion before every handoff, and
> finishing-a-development-branch at the end of each PR.

## Goal

Close the security, release, packaging, reliability, privacy, CI, website, and
maintainability gaps found in the 2026-07-23 assessment without weakening the
project's FC/IS, Effect, Tagless Final, adopter-safety, or workflow-pin
guarantees.

The end state is:

- privileged workflows execute only immutable trusted code;
- untrusted branches cannot redefine the workflow or permission boundary that
  evaluates their code;
- long-lived App credentials exist only as protected-environment secrets and
  are unavailable to branch-controlled workflows;
- pull-request jobs never retain repository write credentials while executing
  PR-controlled code;
- `bun run check` passes from a clean clone and from `nix develop`;
- all published Node and Nix entry points have executable smoke tests;
- model and Git operations have bounded time, request, token, and output usage;
- normal logs contain metadata rather than source or generated prose;
- CI path filters run every check affected by a change;
- the website has its own dependency and quality gates;
- large orchestration modules have smaller, explicit responsibilities; and
- security, architecture, CI, and runtime documentation matches actual
  behavior.

## Non-goals

- Redesigning the PR title/body product experience.
- Adding another AI provider.
- Changing the public configuration format except where a bounded-execution
  setting is required.
- Replacing Effect, FC/IS, Tagless Final, Bun, Astro, or Nix.
- Committing generated `dist/` in feature PRs. Existing post-merge automation
  remains responsible for `dist/`.
- Raising coverage merely to maximize a percentage. Tests must cover behavior
  and failure modes.

## Delivery rules

1. Freeze releases and privileged auto-PR runs until Workstreams 1 and 2 land.
2. Restore the main quality gate first so every security PR can satisfy the
   repository's mandatory `bun run check` rule.
3. Use one `ai/**` branch and one focused PR per workstream. Use a worktree at
   `.worktrees/<branch>` when the relevant skill is available.
4. Follow RED-GREEN-REFACTOR. Commit the failing regression test separately
   when practical.
5. After each task, run its focused checks. Before every commit or PR handoff,
   run `bun run check` and fix failures until it passes.
6. For workflow edits, also run `bun run act -- check-workflows`; align
   self-referential pins to the tested commit as documented in `docs/CI.md`.
7. For significant decisions, update an ADR, `docs/ARCHITECTURE.md`, and
   `AGENTS.md` where the decision creates or changes an agent rule.
8. Do not combine opportunistic dependency upgrades or refactors with the
   security workstreams.

## Dependency order

```text
Workstream 0: restore green gate
        |
        +--> Workstream 1: auto-PR privileged boundary
        |
        +--> Workstream 2: Nix CI credential boundary
                    |
                    +--> Workstream 3: Nix runtime/package repair
                                  |
                                  +--> Workstream 4: Node/package contract

Workstream 0 --> Workstream 5: privacy/logging
             --> Workstream 6: bounded routing and generation
             --> Workstream 7: CI/website coverage

Workstreams 1-7 --> Workstream 8: module decomposition and documentation
                --> Workstream 9: final security and release verification
```

Workstreams 1 and 2 may be developed independently after Workstream 0, but the
recommended merge order remains numeric so each PR starts from a known green
base.

## Planned branches and PRs

| Order | Branch | Primary outcome |
| --- | --- | --- |
| 0 | `ai/restore-quality-gate` | Audit and per-file coverage pass |
| 1 | `ai/secure-auto-pr-boundary` | Privileged create runs immutable code |
| 2 | `ai/secure-nix-ci-credentials` | PR Nix execution is read-only |
| 3 | `ai/repair-nix-runtime` | Nix package, app, and dev shell work |
| 4 | `ai/verify-node-package-runtime` | Real Node 24 LTS package smoke gate |
| 5 | `ai/redact-content-logs` | Content-free default logs and accurate privacy docs |
| 6 | `ai/bound-model-execution` | Shared timeouts, budgets, schemas, and output caps |
| 7 | `ai/close-ci-path-gaps` | Dependency-aware root and website checks |
| 8 | `ai/decompose-orchestration` | Smaller modules and synchronized docs |
| 9 | `ai/remediation-final-verification` | End-to-end evidence and release readiness |

## Security invariants

These invariants override implementation convenience:

1. Treat the workflow files in a same-repository `ai/**` branch or pull-request
   merge ref as untrusted code. A `permissions:` declaration inside such a file
   is not a security boundary because the branch can edit or remove it.
2. An untrusted checkout may run only from an immutable
   default-branch-controlled workflow or under an administrator-enforced
   external permission ceiling that the branch cannot modify. Repository tests
   are defense in depth; an untrusted branch can delete tests in its own
   workflow revision.
3. Do not store `APP_PRIVATE_KEY` as a repository secret. Store App credentials
   in a dedicated protected environment, and make every App-secret consumer
   reference that environment. Restrict it to trusted/default-branch refs,
   prevent self-review and administrator bypass where the GitHub plan supports
   those controls, and require trusted reviewers when available.
4. If a private repository's GitHub plan cannot enforce the required
   environment protections, use an external secret broker/permission ceiling
   or explicitly exclude same-repository branch authors from the threat model.
   There is no insecure repository-secret fallback.
5. A portable automatic same-repository `push` workflow cannot simultaneously
   treat its own workflow revision as untrusted and trust declarations inside
   that revision. The implementation must therefore choose a
   default-branch-only ingress (`repository_dispatch`, `workflow_dispatch`,
   `schedule`, or a carefully constrained `pull_request_target`) or require an
   externally enforced Actions policy. Preserve immediate push automation only
   when that external trust anchor exists.
6. “Same repository,” “collaborator,” and “workflow passed tests” do not imply
   trusted code.

Official references to verify during the ADR work:

- [GitHub workflow revisions and event refs](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflows)
- [Default-branch-only `repository_dispatch`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#repository_dispatch)
- [GitHub Actions secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use)
- [Environment protection and environment secrets](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [Node.js release status](https://nodejs.org/en/about/previous-releases)

---

## Workstream 0: Restore the mandatory quality gate

**Why first:** Every later change must pass `bun run check`. The current gate
fails before it can protect the security fixes.

**Primary files:**

- `package.json`
- `bun.lock`
- `bun.nix`
- `test/auto-pr/github-models-catalog-repository.test.ts`
- `src/auto-pr/live/github-models-catalog-repository.ts` only if a test exposes
  an implementation defect

### Task 0.1: Capture the failing baseline

- [ ] Run `bun run check` and save the exact audit and coverage failures in the
  PR description.
- [ ] Run `bun pm why fast-uri`, `bun pm why brace-expansion`, and
  `bun pm why js-yaml` to identify every dependency path.
- [ ] Confirm the findings are transitive tooling dependencies rather than
  shipped runtime dependencies. Do not downgrade severity solely for that
  reason: the repository gate intentionally covers development and release
  tooling.

### Task 0.2: Remove or upgrade vulnerable dependency paths

- [ ] Replace `npm-run-all` in `check:code` with explicit Bun scripts or simple
  shell sequencing. Do not add another process-runner dependency merely to
  preserve parallel execution.
- [ ] Upgrade the direct parents of vulnerable `fast-uri`, `brace-expansion`,
  and `js-yaml` versions.
- [ ] Use `overrides` only when the patched transitive version is API-compatible
  and the direct parent cannot yet be upgraded. Add a comment explaining any
  temporary override and the condition for removing it.
- [ ] Run `bun install`, regenerate `bun.nix` with
  `nix run .#update-bun-nix`, and review both lockfile diffs.
- [ ] Verify `bun audit --audit-level=high` exits zero.

**Suggested commits:**

- `build: replace npm-run-all in the check pipeline`
- `chore(deps): update vulnerable tooling dependencies`

### Task 0.3: Cover the catalog repository behavior

Write failing tests before changing implementation. Add cases for:

- [ ] successful JSON parsing, including trimmed IDs and model limits;
- [ ] malformed top-level and per-entry data;
- [ ] missing or invalid optional fields and their documented defaults;
- [ ] non-2xx responses;
- [ ] rejected fetch promises;
- [ ] invalid JSON;
- [ ] timeout/abort behavior, retaining the existing TestClock test; and
- [ ] assurance that the redacted token is used only as an authorization header
  and never included in errors or logs.

Use `runEffect(...)` helpers where practical.

**Acceptance:**

- [ ] `bun test test/auto-pr/github-models-catalog-repository.test.ts` passes.
- [ ] `src/auto-pr/live/github-models-catalog-repository.ts` exceeds the
  repository's 75% per-file function and line thresholds through meaningful
  behavior tests.
- [ ] `bun run check` exits zero.

**Suggested commit:** `test: cover GitHub Models catalog repository behavior`

---

## Workstream 1: Rebuild the auto-PR privileged trust boundary

**Severity:** Critical.

**Current defect:** The unprivileged generate path derives
`github:knirski/auto-pr#<ai-branch>`. The privileged create job installs that
ref and executes it with a GitHub App token. This violates the declared rule
that untrusted branch code is never executed in a privileged context.

**Primary files:**

- `docs/adr/0002-two-phase-auto-pr-workflow.md`
- `docs/adr/0016-immutable-privileged-workflow-executor.md` (new)
- `docs/adr/README.md`
- `docs/WORKFLOW_SECURITY.md`
- `docs/ARCHITECTURE.md`
- `AGENTS.md`
- `.cursor/rules/*.mdc` if corresponding workflow policy exists
- `.github/workflows/auto-pr.yml`
- `.github/workflows/auto-pr-create.yml` (new default-branch listener)
- `.github/workflows/auto-pr-generate-reusable.yml`
- `.github/workflows/auto-pr-create-reusable.yml`
- `.github/actions/auto-pr-set-pkg/**`
- `.github/actions/auto-pr-run-command/**`
- `.github/actions/update-workflow-pins/**`
- every workflow that consumes `APP_ID` or `APP_PRIVATE_KEY`, including
  release, dist, pin-update, and Nix-maintenance workflows
- `src/core/init-core.ts`
- `src/tools/auto-pr-init.ts`
- `test/core/init-core.test.ts`
- `test/tools/init.test.ts`
- workflow/action regression tests under `test/scripts/`

### Task 1.1: Verify GitHub workflow trust semantics and record the decision

Research with GitHub MCP first, then official GitHub documentation. Record:

- [ ] which revision supplies a workflow definition for `push`,
  `workflow_run`, and reusable workflow calls;
- [ ] which default-branch-only ingress preserves acceptable product behavior:
  an external GitHub App/webhook issuing `repository_dispatch`, manual
  `workflow_dispatch`, scheduled discovery, or an administrator-enforced
  workflow execution protection;
- [ ] when repository and environment secrets become available;
- [ ] the `GITHUB_SHA`, `GITHUB_REF`, `workflow_run.head_sha`, repository,
  branch, actor, and conclusion values on the privileged trigger;
- [ ] how to download an artifact from the exact triggering run;
- [ ] artifact retention and rerun behavior;
- [ ] the GitHub-plan limitations of environment branch rules, required
  reviewers, self-review prevention, and administrator bypass;
- [ ] how to prove that a same-repository branch cannot replace its workflow
  definition or elevate its token;
- [ ] which external policy or event bridge is mandatory if immediate
  push-triggered behavior remains a requirement; and
- [ ] how adopters receive and update the trusted executor SHA.

Create ADR 0016. The recommended decision is:

1. Remove the branch-defined `push` workflow as a claimed trust boundary.
   Generation starts only through a workflow definition guaranteed to come
   from the default branch, or through an administrator-enforced external
   policy that prevents the branch from redefining permissions.
2. The portable baseline is a default-branch `workflow_dispatch` entry.
   Automatic mode requires a trusted `repository_dispatch` event bridge,
   scheduled default-branch discovery, or a proven Actions workflow execution
   protection. Document the latency/operations trade-off of the selected mode.
3. The generate phase has no long-lived secrets, receives a read-only token
   imposed outside untrusted branch content, checks out the requested head SHA
   explicitly, and produces data only.
4. A second default-branch-controlled privileged workflow runs after successful
   generation. `workflow_run` may be used for this second transition only after
   the first ingress is independently trusted.
5. The privileged workflow downloads only the artifact from the triggering run
   ID and validates repository, event, branch, head SHA, conclusion, artifact
   name, expected files, and the source ref's current SHA.
6. The executor package is pinned to a literal full 40-character trusted SHA.
   The artifact, source branch, and generate job cannot select it.
7. The privileged workflow never checks out or installs the triggering branch.
8. Every App-secret consumer uses a protected environment restricted to
   trusted/default-branch refs. `APP_PRIVATE_KEY` is removed from repository
   secrets; a protected environment is mandatory, not a fallback.
9. If GitHub plan limitations prevent enforcement, fail setup closed and
   document the required external broker/policy. Do not silently weaken the
   same-repository-untrusted threat model.

Amend ADR 0002 to mark its current same-run implementation as superseded by
ADR 0016.

### Task 1.2: Add failing trust-boundary regression tests

Add repository-level tests that parse workflows and action scripts rather than
relying only on actionlint.

- [ ] Assert no privileged job consumes an `auto_pr_pkg`, package ref, branch
  ref, or executable path produced by the generate job.
- [ ] Assert executor refs accepted by a privileged job are exactly 40
  lowercase hexadecimal characters.
- [ ] Assert privileged jobs never use `github.ref_name`,
  `workflow_run.head_branch`, artifact contents, or arbitrary workflow inputs
  as an executable/package ref.
- [ ] Assert the create job has no checkout of the triggering ref.
- [ ] Assert no untrusted auto-PR phase is entered by a branch-defined `push`
  or `pull_request` workflow unless a separately verified administrative
  policy is part of the tested deployment contract.
- [ ] Assert every App-secret-consuming job names the protected environment.
- [ ] Assert no workflow reads `APP_PRIVATE_KEY` from repository-level secrets
  or offers a repository-secret fallback.
- [ ] Assert the App token is generated only after all artifact and identity
  validation.
- [ ] Assert only title, body, branch, default branch, head SHA, and a
  versioned artifact manifest are accepted as artifact data.
- [ ] Add hostile fixtures: shell metacharacters, path traversal, symlinks,
  oversized files, unexpected files, mismatched run/head SHA, and a malicious
  package ref.
- [ ] Assert the workflow fails closed for every hostile fixture.

Expected RED result: at least the dynamic-package-ref test fails against the
current workflow.

### Task 1.3: Separate the unprivileged and privileged triggers

- [ ] Replace the branch-controlled `push` entry with the default-branch-only
  ingress selected in ADR 0016. Make any required event bridge or
  administrator policy an explicit installation prerequisite.
- [ ] Make generate upload a versioned manifest containing immutable identity
  fields and content digests.
- [ ] Remove `auto_pr_pkg` from generate outputs and artifacts.
- [ ] Remove branch-derived package selection from `auto-pr-set-pkg`; delete
  the action if it no longer has a trusted use.
- [ ] Trigger the create phase from the default-branch-controlled mechanism
  selected in ADR 0016.
- [ ] Add per-repository-and-branch create concurrency with
  `cancel-in-progress: true` so a newer head supersedes an older pending run.
- [ ] Download the artifact by exact run ID.
- [ ] Validate event name, source repository, `ai/**` branch, successful
  conclusion, triggering head SHA, manifest version, file allowlist, size
  limits, and content digests before minting a token.
- [ ] Immediately before entering the protected environment/token step, query
  the source ref through a read-only API and require its current SHA to equal
  the triggering SHA.
- [ ] Pass the expected head SHA into the PR client and repeat the ref check
  immediately before create/update so a push racing the earlier check fails
  closed.
- [ ] Copy artifact data without following symlinks and without executing it.
- [ ] Install or invoke only the literal trusted executor SHA.
- [ ] Retain minimal permissions: generate gets `contents: read` and
  `models: read`; create gets only the read permission needed for artifacts and
  `pull-requests: write`.
- [ ] Move `APP_ID` and `APP_PRIVATE_KEY` to a protected environment used by
  the create job. Remove the repository-scoped private key.
- [ ] Keep the App token lifetime and scope minimal.

### Task 1.4: Update adopter initialization and migration

- [ ] Add the new default-branch create/listener workflow to
  `getInitFileSpecs` so `auto-pr-init` installs both halves atomically.
- [ ] Add core tests for both workflow destinations, source URLs, modes,
  ordering, and skip/overwrite behavior.
- [ ] Add tool-level tests proving a fresh empty repository receives both
  workflow files and rerunning init does not leave mixed versions.
- [ ] Update init output with the protected-environment name, branch
  restrictions, required-reviewer requirements, secret migration steps, and
  any trusted event-bridge setup.
- [ ] Fail initialization or print a blocking postcondition when the selected
  secure trigger/environment cannot be configured automatically. Never report
  setup complete after installing only one workflow.
- [ ] Update `INTEGRATION.md`, `TROUBLESHOOTING.md`, website setup content, and
  upgrade instructions for existing one-workflow adopters.
- [ ] Add a packed Node CLI fixture proving `auto-pr-init` installs both entry
  workflows without repository `node_modules`.

### Task 1.5: Extend workflow pin automation

If the selected design stores the executor SHA in the adopter workflow:

- [ ] Teach `update-workflow-pins` to update and validate the executor SHA
  alongside self-referential workflow/action pins.
- [ ] Require all trusted auto-pr references in one workflow to use the same
  full SHA.
- [ ] Verify every referenced path exists at that SHA.
- [ ] Extend `scripts/smoke-update-pins-check-only.sh` with positive and
  mismatched-SHA cases.

### Task 1.6: Protect all App-secret consumers

- [ ] Inventory every `APP_ID`/`APP_PRIVATE_KEY` reference, not only auto-PR.
- [ ] Prove in an adopter fixture which repository owns/resolves an environment
  referenced inside a reusable workflow. If the reusable job cannot consume
  the caller repository's protected environment, keep token creation and the
  privileged command in the adopter's default-branch listener and invoke only
  a full-SHA-pinned action/package from there.
- [ ] Move release-please, dist update, workflow-pin update, release-PR dist,
  and trusted Nix maintenance jobs to the same or purpose-specific protected
  environments.
- [ ] Restrict each environment to the default/protected branch or exact trusted
  tag pattern needed by that workflow.
- [ ] Remove repository-level App private keys after environment secrets are
  populated.
- [ ] Add a documented live-repository settings check, because YAML tests
  cannot prove environment configuration.
- [ ] If required reviewers are unavailable for a private repository plan,
  require an external secret broker or narrow the documented threat model
  before enabling privileged automation.

### Task 1.7: Remove the CodeQL suppression

- [ ] Re-enable the previously excluded untrusted-checkout workflow queries.
- [ ] Run CodeQL or its closest local/static equivalent against the new
  workflows.
- [ ] Do not add a replacement suppression unless a specific result has a
  documented, reviewed proof of safety.

### Task 1.8: Verify and roll out safely

- [ ] Run focused workflow tests, `bun run lint:workflows`,
  `bun run lint:scripts`, `bun run act -- check-workflows`, and
  `bun run check`.
- [ ] Test in a non-production repository with a benign `ai/**` branch.
- [ ] Test hostile artifacts and mismatched head SHAs.
- [ ] Start two generation runs for the same branch in reverse completion
  order; confirm only the newest head can mutate the PR.
- [ ] Change the source ref after generation; confirm the stale artifact is
  rejected both before token creation and inside the PR client.
- [ ] Modify the untrusted branch's workflow files to request write
  permissions and exfiltrate a sentinel; confirm the immutable ingress or
  administrative policy prevents that workflow revision from establishing the
  auto-PR execution boundary.
- [ ] Confirm no branch-selected code runs after the App token is created.
- [ ] Confirm an adopter installed by `auto-pr-init` receives both entry
  workflows and fails closed without the protected environment.
- [ ] Update adopter migration instructions and release notes.

**Suggested commits:**

- `docs(adr): require immutable privileged workflow executors`
- `test(workflows): reproduce untrusted auto-pr package execution`
- `fix(workflows): isolate privileged auto-pr creation`
- `fix(workflows): pin the privileged executor`
- `feat(init): install both secure auto-pr entry workflows`
- `fix(security): scope App credentials to protected environments`
- `docs(security): document the hardened two-phase workflow`

---

## Workstream 2: Remove write credentials from PR-controlled Nix execution

**Severity:** Critical.

**Current defect:** Same-repository PRs can cause the Nix job to check out
PR-controlled code with a persisted App token and then execute
`nix run .#update-bun-nix`.

**Primary files:**

- `.github/workflows/ci.yml`
- a new default-branch-controlled Nix check entry if ADR 0016's ingress is
  shared, or a dedicated immutable `pull_request_target`/dispatch workflow
- `.github/workflows/nix.yml`
- `.github/workflows/update-bun-nix.yml`
- `.github/actions/setup-nix-with-cache/action.yml` if inputs change
- `docs/adr/0006-nix-ci-upstream-and-caching.md`
- `docs/CI.md`
- `docs/WORKFLOW_SECURITY.md`
- workflow regression tests

### Task 2.1: Add a failing credential-boundary test

- [ ] Assert every `pull_request`-reachable Nix job has at most
  `contents: read`.
- [ ] Assert the workflow definition that checks out PR-controlled Nix is
  resolved from the default branch, or document and verify the
  administrator-enforced permission ceiling that prevents the PR revision from
  changing permissions.
- [ ] Assert every checkout in those jobs sets
  `persist-credentials: false`.
- [ ] Assert no App token is created in a PR-reachable job.
- [ ] Assert no PR-reachable job contains `git push`.
- [ ] Assert a job cannot select an arbitrary `ref` and simultaneously receive
  write permissions.
- [ ] Assert dependency code, Nix evaluation, builds, hooks, and tests all
  finish before a trusted update job mints a write token.

Expected RED result: the current `bun-nix` job violates these assertions.

### Task 2.2: Split check-only and mutation flows

- [ ] Do not rely on `ci.yml` from the PR merge ref to enforce its own
  read-only permissions. Route PR-controlled Nix execution through a
  default-branch-controlled workflow, or require and verify an
  administrator-enforced permission ceiling outside repository content.
- [ ] If `pull_request_target` is selected, explicitly set
  `permissions: contents: read`, pass no secrets, do not restore or save a
  privileged/shared cache, validate the source repository and exact head SHA,
  and checkout only that SHA. Record why this use satisfies GitHub's warning
  against privileged untrusted checkouts.
- [ ] Make the immutable Nix check read-only for all PRs, including same-repo
  PRs.
- [ ] Remove `push_allowed` from the PR CI contract.
- [ ] Check whether `bun.nix` is current and fail with deterministic local
  remediation instructions when it is stale.
- [ ] Keep `update-bun-nix.yml` as a named `workflow_dispatch` entry running
  only from the default branch.
- [ ] In the trusted update workflow, checkout the default branch with
  `persist-credentials: false`, run dependency installation and
  `nix run .#update-bun-nix`, inspect the exact `bun.nix` diff, and run relevant
  checks before creating an App token.
- [ ] Disable repository hooks and signing helpers, create the `bun.nix` commit,
  verify its parent/tree/message and confirm no other path changed, all before
  creating an App token.
- [ ] Mint the write token only after the final commit object exists. After
  token creation, execute only credential setup and a hooks-disabled
  `git push`; do not run `git commit`, builds, checks, filters, signing,
  repository scripts, or post-push repository commands.
- [ ] Limit the commit to `bun.nix`; fail if any other path changed.
- [ ] Store the updater's App credentials only in the protected environment
  defined by Workstream 1.
- [ ] Preserve fork-safe behavior without special-casing forks into the
  security model.

### Task 2.3: Update the Nix ADR and docs

- [ ] Amend ADR 0006: PRs check generated state; trusted default-branch
  maintenance updates generated state.
- [ ] Update `docs/CI.md` commands and expected behavior.
- [ ] Remove text claiming trusted same-repo PRs may update and push `bun.nix`.
- [ ] Document that “same repository” is not equivalent to “trusted code.”

### Task 2.4: Verify

- [ ] Run `bun run lint:workflows`, workflow regression tests,
  `bun run act -- check-workflows`, `nix flake check -L`, and `bun run check`.
- [ ] Open a test PR with a deliberately stale `bun.nix`; confirm it fails
  read-only and exposes no token.
- [ ] Modify that PR's workflow to request write permissions; confirm the
  default-branch-controlled workflow or administrative ceiling prevents it
  from changing the Nix job's effective boundary.
- [ ] Run the manual updater on a trusted test branch/default-branch fixture;
  confirm only `bun.nix` is committed before token creation and pushed after
  token creation.

**Suggested commits:**

- `test(workflows): prohibit write credentials in PR Nix jobs`
- `fix(ci): make pull-request Nix checks read-only`
- `ci(nix): isolate trusted bun.nix updates`
- `docs(ci): document read-only Nix pull-request checks`

---

## Workstream 3: Repair Nix package, app, and development shell

The Nix best-practices review requires store-qualified runtimes, one package
derivation reused by the app, shared `nixpkgs` inputs through `follows`, and a
dev shell whose advertised commands work without host-global tools.

**Primary files:**

- `default.nix`
- `flake.nix`
- `flake.lock` if a toolchain input changes
- `.nvmrc`
- `.bun-version`
- `package.json`
- `bun.nix`
- `docs/CI.md`
- `CONTRIBUTING.md`

### Task 3.1: Add failing Nix executable checks

Add flake checks that reproduce all observed defects:

- [ ] the installed `bin/run-auto-pr` does not contain a literal unresolved
  `$out`;
- [ ] the launcher closure references its Node runtime;
- [ ] the package starts far enough to resolve all bundled modules;
- [ ] `nix run .#default -- --help` or an equivalent side-effect-free smoke
  command succeeds;
- [ ] the app points to the built package rather than `${self}` source;
- [ ] `nix develop -c bun --version` matches `.bun-version`;
- [ ] `nix develop -c node --version` is the supported Node 24 LTS baseline
  and satisfies `engines.node`;
- [ ] `nix develop -c bun run lint` succeeds on NixOS; and
- [ ] `nix develop -c bun run check:docs` succeeds on NixOS.

If the CLI lacks a safe `--help`, add a small, tested help path rather than
using real credentials or network calls in a smoke check.

### Task 3.2: Fix the package launcher

- [ ] Replace the hand-written `echo` wrapper with `makeWrapper`,
  `writeShellApplication`, or an equally store-safe Nix primitive.
- [ ] Reference `${pkgs.nodejs_24}/bin/node` directly or include it through
  declared `runtimeInputs`.
- [ ] Embed the realized package output path at build time.
- [ ] Keep build-only tools in `nativeBuildInputs`; do not rely on them at
  runtime.
- [ ] Confirm the packaged `dist` is sufficient without `node_modules`. If it
  is not, fix the bundle or explicitly package runtime dependencies.

### Task 3.3: Make the flake app reuse the package

- [ ] Bind the package once in the per-system `let`.
- [ ] Expose it as `packages.default`.
- [ ] Build `apps.default` with `flake-utils.lib.mkApp` or an equivalent app
  pointing at `${packages.default}/bin/run-auto-pr`.
- [ ] Remove the app that changes into `${self}` and invokes ambient `bun`.
- [ ] Preserve the existing `nixpkgs`/`bun2nix` follows relationship.

### Task 3.4: Make the dev shell reproducible

- [ ] Adopt Node 24 LTS as the supported runtime baseline. At implementation
  time, recheck the official Node release schedule and use a supported LTS
  present in nixpkgs; do not embed an EOL runtime.
- [ ] Align `engines.node`, `.nvmrc`, the Nix runtime/dev shell,
  `@types/node`, setup actions, and documentation on Node 24.
- [ ] Treat Node 20 as unsupported because it reached EOL in 2026. Add a
  separate compatibility-only test only if an ADR explicitly accepts the
  security and maintenance cost; never ship Node 20 in the Nix closure.
- [ ] Align Bun with `.bun-version` and `packageManager`; establish one
  documented update procedure so versions cannot drift silently.
- [ ] Provide Nix-native Biome and rumdl executables on NixOS.
- [ ] Append `node_modules/.bin` after Nix-provided tools rather than shadowing
  compatible Nix binaries with generic Linux binaries.
- [ ] Add a flake check that fails on Bun version drift.
- [ ] Document which tools come from Nix and which remain project
  dependencies.

### Task 3.5: Verify all supported systems

- [ ] Run `nix fmt`.
- [ ] Run statix and deadnix.
- [ ] Run `nix flake check -L` locally on x86_64-linux.
- [ ] Let CI verify aarch64-linux and aarch64-darwin.
- [ ] Run the built output path directly with a restricted PATH.
- [ ] Run `nix run .#default -- --help`.
- [ ] Run `nix develop -c bun run check`.
- [ ] Run the normal `bun run check`.

**Suggested commits:**

- `test(nix): add package and dev-shell smoke checks`
- `fix(nix): provide the runtime in the installed launcher`
- `fix(nix): run the default app from the built package`
- `fix(nix): align the development toolchain`

---

## Workstream 4: Enforce the supported Node and published-package contract

**Primary files:**

- `test/scripts/auto-pr-build-model-routing-context.test.ts`
- new package smoke tests under `test/package/`
- `package.json`
- `.github/workflows/check.yml`
- `.github/actions/build-and-commit-dist/action.yml`
- `scripts/check-package-manifest.ts`
- documentation describing supported runtimes

### Task 4.1: Correct the misleading Node test

- [ ] Add a failing assertion that the spawned executable is actually Node,
  not `process.execPath` under Bun.
- [ ] Resolve the Node 24 executable explicitly from PATH in CI/dev shell.
- [ ] Rename the test if it tests only module syntax; reserve “runs with Node”
  for an actual Node process.

### Task 4.2: Add a packed-artifact smoke suite

- [ ] Build once.
- [ ] Create the same package artifact consumers receive.
- [ ] Install it into a temporary directory with Node 24/npm without access to
  repository `node_modules`.
- [ ] Assert all six manifest bins exist and are executable.
- [ ] Run a side-effect-free `--help`, parser fixture, or mocked command for
  each bin under Node.
- [ ] Assert no bin imports `src/**`, Bun-only modules, or files excluded from
  the package manifest at runtime.
- [ ] Assert failed builds cannot be hidden by the `prepare` script. Remove the
  swallowed build failure if tests prove it is unnecessary.
- [ ] Keep the post-merge dist check as defense in depth, but move the minimum
  Node compatibility gate into pull-request CI.

### Task 4.3: Verify adopter installation paths

- [ ] Test the GitHub-SHA package form used by workflows.
- [ ] Test the documented npm/npx path if the package is published there.
- [ ] Test `auto-pr-init` in an empty fixture repository.
- [ ] Assert `auto-pr-init` writes the supported Node 24 major to `.nvmrc`.
- [ ] Confirm reusable actions still require neither repository Bun nor
  repository `node_modules` at runtime.

**Acceptance:**

- [ ] A real Node 24 process executes every packaged command.
- [ ] The test fails if Bun is substituted for Node.
- [ ] `package.json` engines, `.nvmrc`, `@types/node`, Nix, CI, and docs all
  declare the same supported major.
- [ ] No shipped package or Nix closure embeds Node 20.
- [ ] The package smoke runs in `check.yml`.
- [ ] `bun run check` passes.

**Suggested commits:**

- `build: move the supported runtime baseline to Node 24`
- `test(package): execute built commands with Node 24`
- `ci: gate pull requests on the packed package`

---

## Workstream 5: Make logs and privacy documentation safe by default

**Primary files:**

- `src/auto-pr/diff-toolkit.ts`
- `src/workflow/auto-pr-generate-content.ts`
- `src/workflow/auto-pr-build-model-routing-context.ts`
- `src/workflow/auto-pr-create-or-update-pr.ts`
- `src/core/string.ts` or a new pure logging-redaction core module
- `test/auto-pr/diff-toolkit.test.ts`
- `test/workflow/generate-pr-content.test.ts`
- `test/workflow/create-or-update-pr.test.ts`
- other corresponding log-capture tests
- `SECURITY.md`
- `docs/WORKFLOW_SECURITY.md`
- `docs/INTEGRATION.md`
- `.env.example` and config docs if an explicit debug mode is introduced

### Task 5.1: Add leakage regression tests

Use unique sentinel values resembling source secrets, credentials in Git remote
URLs, and model-generated prose.

- [ ] Capture Effect logs for diff toolkit requests.
- [ ] Capture generation logs for title/body parsing.
- [ ] Capture both the create and update paths' logs with a sentinel generated
  title and assert the current `titlePreview` leak is reproduced before the
  fix.
- [ ] Exercise remote parsing failure with an authenticated URL fixture.
- [ ] Assert no sentinel appears in normal logs, warning logs, formatted
  errors, or GitHub outputs.
- [ ] Assert `Redacted` values never appear.

### Task 5.2: Replace payload logs with metadata

- [ ] Remove `response_preview` for diffs from normal logging.
- [ ] Remove generated title, motivation, benefit, risk, and reviewer-note
  bodies from normal logging.
- [ ] Remove `titlePreview` from both create and update events in
  `auto-pr-create-or-update-pr.ts`; retain only title length and operation
  status.
- [ ] Retain useful metadata: character counts, section counts, provider,
  model, attempt, validation outcome, truncation flags, and stable
  non-reversible identifiers where justified.
- [ ] Never log a raw Git remote. Log only a sanitized host and parsed
  owner/repository, or a content-free parse-failed event.
- [ ] If content logging remains necessary for troubleshooting, require an
  explicit opt-in debug flag, redact known secret shapes, document the risk,
  and keep it disabled in stock workflows.

### Task 5.3: Correct the data-flow documentation

- [ ] Replace “No telemetry—does not send data outside the workflow” with a
  precise statement: no product telemetry, while commit metadata and requested
  diffs are sent to the configured model provider and GitHub APIs.
- [ ] Document provider endpoints, which data may be sent, configuration that
  changes the destination, and the user's responsibility for provider
  retention/privacy terms.
- [ ] Correct the claim that Gitleaks runs on every change unless Workstream 7
  makes that statement true first.

**Suggested commits:**

- `test(security): detect source and credential leakage in logs`
- `fix(logging): keep generation and create logs content-free by default`
- `docs(security): document model-provider data egress`

---

## Workstream 6: Bound and consolidate model-routing execution

**Primary files:**

- `src/workflow/auto-pr-build-model-routing-context.ts`
- `src/workflow/auto-pr-generate-content.ts`
- `src/auto-pr/live/github-models-catalog-repository.ts`
- `src/auto-pr/interfaces/github-models-catalog-repository.ts`
- `src/auto-pr/git-context.ts`
- `src/core/github-model-routing.ts`
- `src/core/github-model-fallback-policy.ts`
- `src/core/routing-artifacts.ts`
- `src/core/diff-tool-roundtrip.ts`
- `src/auto-pr/config.ts`
- matching tests
- ADR 0013 and ADR 0015

### Task 6.1: Specify global execution limits

Amend ADR 0013/0015 before implementation. Define:

- [ ] one wall-clock deadline for the complete generation operation;
- [ ] maximum model candidates;
- [ ] maximum total model requests, including repairs and retries;
- [ ] maximum total tool rounds across retries and candidates;
- [ ] maximum input and output token budgets across the operation;
- [ ] per-request HTTP and Git timeouts;
- [ ] retryable versus permanent errors;
- [ ] behavior when any budget is exhausted; and
- [ ] content-free metrics emitted for observability.

The budget must not reset when switching models or retrying an entire
multi-round interaction.

### Task 6.2: Add failing timeout and budget tests

Use TestClock and injected services.

- [ ] stalled Git command;
- [ ] stalled catalog request;
- [ ] stalled repository-owner request;
- [ ] retryable model error until global request budget is exhausted;
- [ ] tool-calling model until global tool-round budget is exhausted;
- [ ] fallback across multiple models without budget reset;
- [ ] malformed response repair without exceeding the total request limit;
- [ ] deterministic final error identifying the exhausted budget; and
- [ ] no real sleeps or network calls.

### Task 6.3: Remove duplicate catalog and HTTP implementations

- [ ] Move pure catalog decoding to one core module.
- [ ] Use `GithubModelsCatalogRepository` from both generation and routing
  shells.
- [ ] Introduce or reuse an injected repository-metadata client rather than a
  second raw `fetchJson`.
- [ ] Apply `AbortSignal` plus Effect timeout to every network call.
- [ ] Replace unbounded `spawnSync` Git calls with `GitContext` or an injected
  command service with timeout, output-size limit, and domain error mapping.
- [ ] Keep core parsing pure and bridge through `Effect.fromResult`.

### Task 6.4: Implement one shared generation budget

- [ ] Add a pure budget state/decision module in `src/core/`.
- [ ] Add an Effect service/interpreter for time and request consumption.
- [ ] Consume budget before each model request and tool round.
- [ ] Pass remaining budgets through retry, repair, fallback, and local-provider
  paths.
- [ ] Cap retry delay by remaining wall-clock time.
- [ ] Emit counts and exhaustion reason without prompt or response content.

### Task 6.5: Harden schemas and GitHub outputs

- [ ] Refine selected model to a trimmed non-empty string.
- [ ] Refine token, round, and character budgets to finite positive bounded
  integers.
- [ ] Validate that the routing decision provider matches the configured
  provider.
- [ ] Cap individual path length, retained changed paths, hotspot count, and
  total serialized routing artifact size.
- [ ] Preserve aggregate counts when detailed lists are truncated.
- [ ] Fail with a domain error before writing an oversized `GITHUB_OUTPUT`.
- [ ] Use multiline GitHub output syntax only when required and safely
  delimited.
- [ ] Add large-change fixtures and boundary-value tests.

**Acceptance:**

- [ ] Every Git and HTTP operation has a tested deadline.
- [ ] One configured generation cannot exceed the global request/tool/token
  limits regardless of retry/fallback shape.
- [ ] Routing outputs remain within the selected safe size budget.
- [ ] Duplicate catalog parsing and raw fetch implementations are removed.
- [ ] `bun run check` and relevant integration tests pass.

**Suggested commits:**

- `docs(adr): define bounded model execution`
- `test: reproduce unbounded routing and generation retries`
- `refactor: share GitHub model catalog and repository clients`
- `fix(ai): enforce global generation budgets`
- `fix(routing): validate and cap routing artifacts`

---

## Workstream 7: Close CI path-filter and website gaps

**Primary files:**

- `.github/workflows/ci.yml`
- `.github/workflows/check.yml`
- `.github/workflows/check-workflows.yml`
- `.github/workflows/check-website.yml`
- `.github/workflows/check-docs.yml`
- `.github/workflows/deploy-pages.yml`
- `.github/dependabot.yml`
- `website/package.json`
- `website/bun.lock`
- `test/website/copy-docs.test.ts`
- `docs/CI.md`

### Task 7.1: Write the check-to-path dependency map

Document and test these relationships:

| Changed area | Required checks |
| --- | --- |
| `src/**`, `scripts/**`, root package/TS config | root check; integration where behavior requires it |
| `.github/actions/**` | workflow/shell lint plus affected root behavioral tests |
| `.github/workflows/**` | actionlint, pin checks, workflow security regression tests |
| `website/**` | website install, audit, typecheck/check, tests, and build |
| documentation copied into the website | docs lint plus website copy/build |
| any path | secret scan |
| Nix/lock inputs | read-only Nix check |

Add tests for the path-filter decisions so future edits cannot silently remove
coverage.

### Task 7.2: Run behavioral tests for workflow/action-only changes

- [ ] Add a focused root-test job or broaden the root check condition for
  `.github/actions/**` and workflow security tests.
- [ ] Keep expensive provider integration tests limited to relevant production
  code.
- [ ] Run Gitleaks independently of the code path filter so “every change” is
  true.
- [ ] Preserve the single `CI / gate` branch-protection contract.

### Task 7.3: Strengthen the website pipeline

- [ ] Add a `/website` Bun entry to Dependabot.
- [ ] Add website scripts for type checking/Astro checking and tests.
- [ ] Run `bun audit --audit-level=high` against `website/bun.lock`.
- [ ] Run `test/website/copy-docs.test.ts` for website script changes.
- [ ] Include copied documentation paths in the website-build filter.
- [ ] Use `bun install --frozen-lockfile` in deployment as well as checks.
- [ ] Keep root and website lockfile audits separate and explicit.

### Task 7.4: Decide link-check enforcement

- [ ] Separate deterministic internal/anchor failures from flaky external-link
  failures.
- [ ] Make deterministic failures blocking.
- [ ] Keep retryable external checks scheduled or advisory only if network
  instability remains unacceptable for the required gate.
- [ ] Document the policy rather than leaving `continue-on-error` unexplained.

### Task 7.5: Verify the matrix

Create small fixture commits or path-filter tests for:

- [ ] workflow-only change;
- [ ] reusable-action shell-only change;
- [ ] website-only change;
- [ ] copied-doc-only change;
- [ ] Nix-only change;
- [ ] root code-only change; and
- [ ] mixed change.

For each, assert the intended jobs run and `CI / gate` reports the aggregate
result.

**Suggested commits:**

- `test(ci): cover path-filter check dependencies`
- `ci: run behavioral checks for workflow changes`
- `ci(website): add audit, checks, and dependency updates`
- `ci(docs): build copied documentation in the website`

---

## Workstream 8: Decompose orchestration hotspots and synchronize policy docs

Start only after the behavior and security regression suites from earlier
workstreams are green. This is a refactor, not a redesign.

**Hotspots:**

- `src/workflow/auto-pr-generate-content.ts` — approximately 1,404 lines
- `src/workflow/auto-pr-build-model-routing-context.ts` — approximately 963
  lines
- `src/auto-pr/config.ts` — approximately 681 lines
- `src/core/model-routing.ts` — approximately 646 lines
- `src/core/fill-pr-template-core.ts` — approximately 535 lines

### Task 8.1: Establish module boundaries

Extract one responsibility at a time:

- [ ] generation attempt state machine;
- [ ] global generation budget;
- [ ] model fallback planner;
- [ ] routing signal collection;
- [ ] GitHub catalog/repository metadata access;
- [ ] routing artifact encoding and GitHub output writing;
- [ ] configuration schemas grouped by provider/domain; and
- [ ] pure PR-template parsing/rendering stages if tests show a useful seam.

Rules:

- interfaces remain in `src/auto-pr/interfaces/`;
- live interpreters remain in `src/auto-pr/live/`;
- pure validation and decisions remain in `src/core/`;
- workflow files orchestrate services rather than recreating clients;
- ADT branches use `Match.value(..., Match.exhaustive)` where practical;
- public imports and package bins remain stable; and
- each extraction begins and ends with green focused tests.

Do not introduce a numeric line-count gate. Completion means each module has one
coherent reason to change and duplicate implementations are gone.

### Task 8.2: Wire the patch-coverage policy or remove it

- [ ] Decide whether `scripts/check-patch-coverage.ts` is normative.
- [ ] If normative, test missing-LCOV-line behavior, wire it into CI, and make
  its rules agree with Codecov.
- [ ] If Codecov alone is authoritative, remove the unused script and package
  command rather than maintaining a weaker dormant policy.

### Task 8.3: Reconcile documentation drift

- [ ] Clarify that “core has no Effect” means no Effect runtime/I/O; immutable
  Effect data types such as `Option`, `Result`, and `Schema` are permitted.
- [ ] Correct the stale “no defaults” comment in `src/auto-pr/config.ts`.
- [ ] Amend ADR 0003 to describe Bun's current test runner rather than Vitest.
- [ ] Update `SECURITY.md` Gitleaks and data-egress claims.
- [ ] Update `docs/ARCHITECTURE.md` for the extracted services/modules.
- [ ] Update `docs/CI.md`, `CONTRIBUTING.md`, and troubleshooting documentation
  for the working Nix/Node checks.
- [ ] Keep `AGENTS.md` and matching `.cursor/rules/*.mdc` policy aligned.

**Suggested commits:**

- `refactor(ai): split generation attempt orchestration`
- `refactor(routing): separate signal collection and output encoding`
- `refactor(config): group provider configuration schemas`
- `chore(coverage): enforce one patch-coverage policy`
- `docs: synchronize architecture, runtime, and security policy`

---

## Workstream 9: Final security and release verification

This workstream changes no behavior unless verification finds a defect.

### Task 9.1: Clean-clone verification

From a fresh worktree or clone:

- [ ] install with the documented Bun version;
- [ ] install Lefthook;
- [ ] run `bun run check`;
- [ ] run `bun run check:with-links`;
- [ ] run `bun run test:integration`;
- [ ] run `bun run act`;
- [ ] run `nix flake check -L`;
- [ ] run `nix develop -c bun run check`;
- [ ] build the Nix package and execute its launcher with a restricted PATH;
- [ ] run `nix run .#default -- --help`; and
- [ ] pack and execute all bins under Node 24 LTS.

Record command, exit code, and relevant totals in the final PR description.

### Task 9.2: Adversarial workflow verification

- [ ] A branch-controlled package ref cannot reach the privileged phase.
- [ ] A same-repository branch cannot redefine the auto-PR or Nix permission
  boundary through its own workflow revision.
- [ ] Every App credential is an environment secret protected from untrusted
  refs; no repository-scoped App private key remains.
- [ ] A malicious artifact is rejected before token creation.
- [ ] A mismatched run, repository, branch, or head SHA is rejected.
- [ ] A generation artifact becomes unusable as soon as its source ref advances,
  and per-branch concurrency prevents an older run from winning.
- [ ] A same-repo PR cannot obtain or persist a Nix write credential.
- [ ] A stale `bun.nix` PR fails read-only.
- [ ] Default logs reveal no source, model prose, remote credentials, tokens, or
  sentinel secrets.
- [ ] CodeQL workflow security queries and Gitleaks pass without blanket
  suppressions.

### Task 9.3: Release readiness

- [ ] Confirm all required GitHub checks are green.
- [ ] Confirm post-merge workflow-pin and `dist` automation still works.
- [ ] Confirm the trusted executor SHA is consistent across all adopter-facing
  workflow references.
- [ ] Confirm `auto-pr-init` installs both the unprivileged and privileged entry
  workflows from the same trusted release.
- [ ] Confirm live protected-environment branch/reviewer/bypass settings, not
  merely the YAML reference to the environment.
- [ ] Review migration notes for existing adopters.
- [ ] Publish release notes with explicit security, Nix, and Node compatibility
  sections.
- [ ] Only then remove the release/privileged-workflow freeze.

---

## Global acceptance criteria

The remediation program is complete only when all statements below are true:

- [ ] `bun run check` passes from a clean clone.
- [ ] Root and website audits contain no high-or-higher findings.
- [ ] Unit coverage passes all per-file thresholds with behavior-focused tests.
- [ ] No privileged workflow executes a ref chosen by an untrusted branch or
  artifact.
- [ ] No same-repository untrusted branch can replace the workflow definition
  or elevate the token that establishes the auto-PR/Nix execution boundary.
- [ ] `APP_PRIVATE_KEY` exists only in protected environments whose live
  settings reject untrusted refs; no repository-secret fallback exists.
- [ ] No PR-controlled job executes with persisted repository write
  credentials.
- [ ] Nix package and app launchers run without ambient Node, Bun, repository
  source, or `node_modules`.
- [ ] `nix develop` provides the documented Bun, Node, lint, and docs tools.
- [ ] The shipped/runtime baseline is supported Node 24 LTS and every published
  bin is executed by a real Node 24 process in PR CI.
- [ ] Every Git, HTTP, model, retry, and tool-call loop is subject to a tested
  bound.
- [ ] Routing artifacts and GitHub outputs have tested schema and size limits.
- [ ] Default logs, including create/update events, contain no source previews,
  generated title/body prose, raw remotes, or secrets.
- [ ] CI path filters have tests and run all affected checks.
- [ ] Website dependencies are updated and audited independently.
- [ ] CodeQL workflow-security coverage is enabled without blanket
  untrusted-checkout suppression.
- [ ] Architecture, ADRs, security policy, CI docs, contributor docs, and agent
  rules describe the implemented system.

## Risks and rollback strategy

| Risk | Mitigation | Rollback |
| --- | --- | --- |
| Default-branch ingress changes adopter setup or latency | Install both workflows in a separate repository; test manual and automatic modes; publish migration steps | Keep privileged auto-PR disabled and use the documented manual dispatch |
| Protected-environment controls are unavailable on an adopter's plan | Detect/document the limitation and require an external broker or narrower threat model | Do not store the private key as a repository secret; keep privileged automation disabled |
| Source branch advances while create waits for approval | Per-branch cancellation plus ref checks before token and immediately before mutation | Reject the stale run and regenerate from the current head |
| Trusted SHA automation drifts | Extend the existing pin checker and require one SHA | Pin manually to last known-good release |
| Read-only Nix PRs add contributor friction | Print exact local and manual-update instructions | Run trusted updater; never restore PR write credentials |
| Nix runtime fix increases closure size | Inspect closure and separate build/runtime inputs | Revert packaging optimization, not runtime correctness |
| Global AI budget reduces completion rate | Emit budget metrics and tune defaults from evidence | Increase bounded defaults; never restore unbounded retries |
| Broader CI filters increase minutes | Use focused behavioral jobs and caching | Optimize job granularity without dropping dependency coverage |
| Log redaction reduces diagnostics | Preserve structured counts/status and opt-in safe debugging | Temporarily enable documented debug mode in a controlled run |

## Completion handoff

After Workstream 9:

1. Use `requesting-code-review` on the complete change set.
2. Run `verification-before-completion` and preserve the evidence.
3. Use `finishing-a-development-branch` to present merge/PR options.
4. After merge, confirm `update-workflow-pins.yml` and `update-dist.yml`.
5. Return to `main`, pull the merged result, and verify the release tag/package
   from the trusted default branch.
