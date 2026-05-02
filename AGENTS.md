# AI Agent Instructions

auto-pr creates PRs from conventional commits on `ai/**` branches. TypeScript, Effect v4 beta, Tagless Final, FC/IS.

**Execution order:** apply rules → make changes → run `bun run check` → fix until pass.

---

## Before any task

### Skills And Rule Sources

[Superpowers](https://github.com/obra/superpowers). **Invoke relevant skills before any task** — if a skill might apply (even 1%), use it. User instructions override skills.

| Situation | Skill |
|-----------|-------|
| New features | brainstorming — design, get approval before coding |
| Approved design | writing-plans — plan in `docs/superpowers/specs/` |
| Feature isolation | using-git-worktrees |
| Features/bugfixes | test-driven-development — RED-GREEN-REFACTOR |
| Bugs/failures | systematic-debugging — root cause first |
| Before completion | verification-before-completion — run `bun run check` |
| Implementation done | finishing-a-development-branch — verify, present options |
| Between tasks | requesting-code-review |

**Project-specific:** ts-scripting (TypeScript, Effect v4, FC/IS). **Philosophy:** TDD, systematic over ad-hoc, evidence over claims.

Codex rules live in `AGENTS.md`. Cursor rules live in `.cursor/rules/*.mdc`; keep them aligned when changing agent policy. Prefer nested `AGENTS.md` files for path-scoped Codex rules:

- `.github/AGENTS.md` — workflows, composite actions, pins, workflow tests.
- `src/core/AGENTS.md` — functional core purity.
- `scripts/AGENTS.md` — shell scripts and local CI harness exception.

---

## Reference (lookup during tasks)

### Commands

| Command | Purpose |
|---------|---------|
| `bun run check` | Full check. Run before committing. |
| `bun run check:code` | Code only. Runs on pre-push. |
| `bun run act` | CI **`check`** then **`integration`** in Docker (default). See [CONTRIBUTING.md](CONTRIBUTING.md#run-ci-locally-check-job). |
| `bun run act -- <mode>` | `check`, `check-workflows`, `integration`, or `all`. Example: `bun run act -- check-workflows`. |
| `bun run act -- --dry-run <mode>` | `act --dryrun` (validate workflow graph). Example: `bun run act -- --dry-run check`. Same flags on `bun scripts/act-local-ci.ts` without the extra `--`. |
| `bun run check:with-links` | Full check + lychee |
| `bun run check:just-links` | Lychee only |
| `bun test` | Unit tests with coverage (`test/integration/**` excluded in [bunfig.toml](bunfig.toml)) — this is what `check:code` runs |
| `bun run test:integration` | Real HTTP AI provider tests: `--env-file=.env.ci` then optional `.env.local` ([`bunfig.integration.toml`](bunfig.integration.toml)); Docker + Testcontainers for local llama — see [docs/CI.md](docs/CI.md#integration-tests), `test/integration/*.integration.test.ts` |
| `bun run test:all` | `bun test` then `test:integration` |
| `bun run lint` / `lint:fix` | Lint (Biome) |
| `bun run lint:scripts` | Shellcheck + shfmt check |
| `bun run format:scripts` | Format shell scripts |
| `bun run typecheck` | TypeScript check |
| `bun run knip` | Unused code detection |

### Where to Put X

| Adding… | Put in |
|---------|--------|
| Pure validation, helpers | `src/core/*.ts` (fill-pr-template-core, string, gh-output, etc.) |
| Dev-tool pure helpers (act-local-ci only) | `scripts/act-local-ci.ts` (alongside the imperative CLI — scoped FC/IS exception; see [CI audit §5](docs/superpowers/specs/2026-04-19-ci-modernization-audit-design.md)). Do not extend this pattern to other code. |
| New config/env | `src/auto-pr/config.ts` |
| New tagged error class | `src/core/errors.ts`; add `formatError` branch in `src/auto-pr/errors.ts` |
| New service interface | `src/auto-pr/interfaces/` |
| New live interpreter | `src/auto-pr/live/`. Layer: `static readonly Live = Layer.effect(...)` |
| AI / LanguageModel adapter | `src/auto-pr/live/ai-provider.ts` (provider dispatcher: `local` \| `github-models`); new providers in `live/` |
| New CLI script | `src/workflow/` or `src/tools/` |
| New shell script | `scripts/` |
| Composite action | `.github/actions/<name>/` |
| TypeScript used by a reusable composite action | `.github/actions/<name>/`; keep source and generated Node bundle together |
| Local llama image pin (CI + init) | `.github/llama-server/Dockerfile` — `FROM` line; tag for Dependabot |
| Llama in Docker on the runner (CI) | `.github/actions/llama-server-docker-start`, `.github/actions/llama-server-docker-stop` — input `llama_server_root`; cached image at `docker/llama-server-image.tar` |
| Dockerfile `FROM` parser + shell parity | `test/integration/dockerfile-from-image.ts`; CI: [resolve-llama-server-tag.sh](.github/actions/resolve-llama-server-tag/resolve-llama-server-tag.sh) (`--dockerfile-image`); tests: `test/integration/dockerfile-from-image.test.ts` |
| New prompt | `src/auto-pr/prompts/` |

### Key Rules

| Rule | Requirement |
|------|-------------|
| Effect first | `effect` and `@effect/*` |
| ADT branching | Prefer `Match.value(...).pipe(..., Match.exhaustive)` over `switch` for discriminated unions |
| No `any`/`!`/`enum` | `unknown`, no non-null asserts, string literal unions |
| No `console.log` | Use `Effect.log` |
| Core pure | No Effect/I/O in `*-core.ts`; bridge with `Effect.fromResult` |
| Domain errors | `Schema.TaggedErrorClass` in `core/errors.ts` |
| Optionals | `Option<T>`, not `T \| null` |
| Nullish style | Prefer optional props / `undefined`; avoid introducing `null` unless API-contract-required |
| File names | kebab-case |
| Secrets | Never `Redacted.value()` for logging |
| Workflow / action pins | Self-refs `knirski/auto-pr/...@` must be **one** full **40-char SHA** (ancestor of branch, every path exists at that commit). Third-party `uses:` = SHA + `# v…` comment; Dependabot updates weekly. Same-repo `uses: ./.github/...` needs no SHA. Llama image: `.github/llama-server/Dockerfile`. Details: [docs/CI.md](docs/CI.md#workflow-pin-automation) |
| Adopter-safe composite actions | Reusable-workflow composites must not require Bun, repo `node_modules`, or imports from `src/**` at runtime. Use an action-local generated Node bundle when TypeScript/Effect logic is needed. |
| Workflow testing | `bun run act` locally; align self-ref `@SHA` to `git rev-parse HEAD` when exercising workflow edits on a branch |
| Multi-commit AI | `LanguageModel.generateText` + JSON parse + Schema decode in `auto-pr-generate-content.ts`; not `generateObject` (`json_schema` unsupported on GitHub Models) |

---

## Project layout

**Setup:** `bun install` then `bun x lefthook install`. Local env for workflow CLIs: copy `.env.example` → `.env` (see `src/auto-pr/config.ts`). Optional Nix: `nix develop` or direnv + `.envrc` (see [CONTRIBUTING.md](CONTRIBUTING.md#nix-flake-optional)). Build: `scripts/build.ts` → `dist/`; typecheck: `tsgo --noEmit`.

```
.github/actions/   — composite actions. Workflows use full path (knirski/auto-pr/...); TypeScript actions keep generated Node bundles action-local
.github/workflows/ — ci, release-please, auto-pr, auto-pr-*-reusable
src/auto-pr/       — config, core (re-exports), errors (formatError; classes in core/errors), interfaces, live, paths, shell, utils
src/workflow/      — generate-content, create-or-update-pr, run
src/tools/         — fill-pr-template, init
src/core/          — pure core (fill-pr-template-core, collapse-prose-paragraphs, init-core, string, gh-output, errors)
scripts/           — shell only
test/              — mirrors src/ layout
```

[ARCHITECTURE.md](docs/ARCHITECTURE.md) — pipeline flow, FC/IS layout.

---

## Development

Develop with **Bun** (`bun run`, `bun test`). **`npx`** in docs and `setup-runtime` is for **adopters** (Node installs and consumer repos).

### Design Principles

- **FC/IS:** Core pure (no Effect, no I/O, returns `Result`). Shell orchestrates I/O, bridges with `Effect.fromResult`. One scoped exception: the local `act` harness in `scripts/act-local-ci.ts` (see "Where to Put X").
- **Tagless Final:** Interfaces + Tags; live in `live/`, tests swap mocks. `Effect.provide(layer)`.
- **Effect first**, config as service, ADTs with `Match.exhaustive`. Core files do not depend on shell.

### Research and Decision-Making

**GitHub MCP first.** Otherwise: (1) Official docs (2) Effect: `effect-smol` LLMS.md — replace `effect%404.0.0-beta.XX` with `package.json` version (3) Popular repos when options exist.

### Branch, commit, checkout

[Superpowers](https://github.com/obra/superpowers): using-git-worktrees, writing-plans, finishing-a-development-branch.

- **Branches:** `ai/` prefix. Isolation: worktree at `.worktrees/<branch>` with `-b ai/<feature>`; `.worktrees/` in `.gitignore`.
- **Commits:** Conventional (`feat:`, `fix:`, `docs:`, `chore:`). Frequent, one per step. Add `Closes #<issue>` when fixing.
- **Completion:** finishing-a-development-branch (verify → 4 options → execute → cleanup). After PR/merge: `git checkout main && git pull`.

---

## Before completion (gate)

**verification-before-completion** — run `bun run check`, read output, state result. Do not finish until pass.

- Add tests when fixing bugs, adding features, or changing risky code. Skip for trivial branches/CLI.
- Coverage ~85%; don't chase for its own sake. Pre-push: `check:code` (Lefthook). `bun x lefthook install` after clone.
- `bun test` can exit non-zero with `0 fail` when `coverageThreshold` is not met. If this happens, inspect the coverage table and raise coverage in changed files (or update threshold intentionally with justification).

## Testing style

- Prefer `runEffect(...)` test helpers over direct `Effect.runPromise(...)` in tests unless there is no practical helper path.

---

## Operations

**GitHub:** MCP first (`mcps/user-github/tools/`). PRs: create/update/merge/read. Issues: write/comment/read. Fallback to `gh` when MCP lacks capability.

**Post-merge:** [update-workflow-pins.yml](.github/workflows/update-workflow-pins.yml) — bumps every `knirski/auto-pr/...@<sha>` to the merge commit when `.github/workflows/**` or `.github/actions/**` changed (not third-party actions or Dockerfiles). If a PR only touched workflows/actions, ensure self-refs already matched **one** SHA before merge; after merge, expect either a follow-up bot commit or run **Update workflow pins** manually if needed. [update-dist.yml](.github/workflows/update-dist.yml) — builds `dist/` on main. Do not commit `dist/` in PRs. [CI.md](docs/CI.md#dist-and-gitignore) · [Workflow pin automation](docs/CI.md#workflow-pin-automation)

**Act smoke:** [act-smoke.yml](.github/workflows/act-smoke.yml) uses a **matrix** so **`--dry-run check`** and **`check-workflows`** run in parallel (no **`--dry-run check-workflows`**; the **`check-workflows`** cell covers that graph). [docs/CI.md](docs/CI.md#run-ci-locally).

---

## Documentation & ADR

[docs/PR_TEMPLATE.md](docs/PR_TEMPLATE.md) · [INTEGRATION.md](docs/INTEGRATION.md) · [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) · [CI.md](docs/CI.md) · [WORKFLOW_SECURITY.md](docs/WORKFLOW_SECURITY.md) · [ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/adr/](docs/adr/) · [CONTRIBUTING.md](CONTRIBUTING.md) (CHANGELOG auto-generated)

### ADR workflow {#adr-workflow}

Add to `docs/adr/` via [template](docs/adr/adr-template.md). Update AGENTS.md and ARCHITECTURE.md if needed. *Significant* change: Research first, document in ADR, update both. Significant = multi-module, hard to reverse, new patterns. Minor refactors: no ADR.
