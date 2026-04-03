# AI Agent Instructions

auto-pr creates PRs from conventional commits on `ai/*` branches. TypeScript, Effect v4 beta, Tagless Final, FC/IS.

**Execution order:** apply rules → make changes → run `bun run check` → fix until pass.

---

## Before any task

### Skills

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

**Project-specific:** ts-scripting (TypeScript, Effect v4, FC/IS), create-rule (Cursor rules). **Philosophy:** TDD, systematic over ad-hoc, evidence over claims.

---

## Reference (lookup during tasks)

### Commands

| Command | Purpose |
|---------|---------|
| `bun run check` | Full check. Run before committing. |
| `bun run check:code` | Code only. Runs on pre-push. |
| `bun run act` | CI **`check`** then **`integration`** in Docker (default). See [CONTRIBUTING.md](CONTRIBUTING.md#run-ci-locally-check-job). |
| `bun run act -- <mode>` | `check`, `check-workflows`, `integration`, or `all`. Example: `bun run act -- check-workflows`. |
| `bun run act -- --dry-run <mode>` | `act --dryrun` (validate workflow graph). Example: `bun run act -- --dry-run check`. Same flags on `bun scripts/run-check-act.ts` without the extra `--`. |
| `bun run check:with-links` | Full check + lychee |
| `bun run check:just-links` | Lychee only |
| `bun test` | Unit tests with coverage (`test/integration/**` excluded in [bunfig.toml](bunfig.toml)) — this is what `check:code` runs |
| `bun run test:integration` | Real HTTP AI provider tests (`bunfig.integration.toml`); needs env — see `test/integration/ai-providers.integration.test.ts` |
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
| New config/env | `src/auto-pr/config.ts` |
| New tagged error class | `src/core/errors.ts`; add `formatError` branch in `src/auto-pr/errors.ts` |
| New service interface | `src/auto-pr/interfaces/` |
| New live interpreter | `src/auto-pr/live/`. Layer: `static readonly Live = Layer.effect(...)` |
| AI / LanguageModel adapter | `src/auto-pr/live/ai-provider.ts` (provider dispatcher: `local` \| `github-models`); new providers in `live/` |
| New CLI script | `src/workflow/` or `src/tools/` |
| New shell script | `scripts/` |
| Composite action | `.github/actions/<name>/` |
| New prompt | `src/auto-pr/prompts/` |

### Key Rules

| Rule | Requirement |
|------|-------------|
| Effect first | `effect` and `@effect/*` |
| No `any`/`!`/`enum` | `unknown`, no non-null asserts, string literal unions |
| No `console.log` | Use `Effect.log` |
| Core pure | No Effect/I/O in `*-core.ts`; bridge with `Effect.fromResult` |
| Domain errors | `Schema.TaggedErrorClass` in `core/errors.ts` |
| Optionals | `Option<T>`, not `T \| null` |
| File names | kebab-case |
| Secrets | Never `Redacted.value()` for logging |
| Workflow testing | `bun run act` locally; update `@SHA` refs to `git rev-parse HEAD` |
| Multi-commit AI | `LanguageModel.generateText` + JSON parse + Schema decode in `auto-pr-generate-content.ts`; not `generateObject` (`json_schema` unsupported on GitHub Models) |

---

## Project layout

**Setup:** `bun install` then `bun x lefthook install`. Local env for workflow CLIs: copy `.env.example` → `.env` (see `src/auto-pr/config.ts`). Build: `scripts/build.ts` → `dist/`; typecheck: `tsgo --noEmit`.

```
.github/actions/   — composite actions. Workflows use full path (knirski/auto-pr/...)
.github/workflows/ — ci, release-please, auto-pr, auto-pr-*-reusable
src/auto-pr/       — config, core (re-exports), errors (formatError; classes in core/errors), interfaces, live, paths, shell, utils
src/workflow/      — get-commits, generate-content, create-or-update-pr, run
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

- **FC/IS:** Core pure (no Effect, no I/O, returns `Result`). Shell orchestrates I/O, bridges with `Effect.fromResult`.
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

---

## Operations

**GitHub:** MCP first (`mcps/user-github/tools/`). PRs: create/update/merge/read. Issues: write/comment/read. Fallback to `gh` when MCP lacks capability.

**Post-merge:** [update-workflow-pins.yml](.github/workflows/update-workflow-pins.yml) — auto-updates self-refs. [update-dist.yml](.github/workflows/update-dist.yml) — builds `dist/` on main. Do not commit `dist/` in PRs. [CI.md](docs/CI.md#dist-and-gitignore)

---

## Documentation & ADR

[docs/PR_TEMPLATE.md](docs/PR_TEMPLATE.md) · [INTEGRATION.md](docs/INTEGRATION.md) · [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) · [CI.md](docs/CI.md) · [WORKFLOW_SECURITY.md](docs/WORKFLOW_SECURITY.md) · [ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/adr/](docs/adr/) · [CONTRIBUTING.md](CONTRIBUTING.md) (CHANGELOG auto-generated)

### ADR workflow {#adr-workflow}

Add to `docs/adr/` via [template](docs/adr/adr-template.md). Update AGENTS.md and ARCHITECTURE.md if needed. *Significant* change: Research first, document in ADR, update both. Significant = multi-module, hard to reverse, new patterns. Minor refactors: no ADR.

---

## Learned User Preferences

- Prefer caret ranges with the lockfile for most dependencies; keep exact or aligned pins only where justified (for example `bun-types` with `packageManager`, Effect beta packages on the same range, `@typescript/native-preview` snapshots).
- Prefer continual-learning hook state under `~/.cursor/hooks/state/` (account-wide) when customizing the plugin; upstream marketplace builds may use workspace-relative paths, so reinstalling the plugin can revert a local `homedir()`-based patch.
- Target auto-generated PR descriptions (and related prompts) at a software-engineer audience; Markdown in the body is appropriate when it improves clarity.
- For GitHub Models integration or smoke tests, prefer `microsoft/phi-4-mini-instruct` when minimizing cost (the catalog may not expose a cheaper `phi-4-nano`-style id).
- For local LLM smoke tests on CI, prefer resource-minimal setups (tiny GGUF, tight constraints) because free-tier GitHub runners have scarce CPU and RAM.

## Learned Workspace Facts

- `scripts/check-nix-hash.sh` warns from git state when `bun.lock` and `bun.nix` may be out of sync; it does not run Nix or replace `nix develop` / `nix flake check`.
- The `picomatch` entry in `package.json` `overrides` is optional for current high-severity audit; without it, nested `picomatch` 2.x under `micromatch` is normal.
- Lefthook pre-commit runs `scripts/check-no-dist-staged.sh`, which fails if any staged path is under `dist/`.
- Dependabot does not bump arbitrary version pins in plain files (for example `.github/llama-cpp-release`); it handles `package.json`/lockfile ecosystems and `github-actions` refs. Use another mechanism for those pins (scheduled workflow, Renovate, or manual bumps).
- Integration CI resolves **`AUTO_PR_AI_OPENAI_COMPAT_MODEL`** for the local provider from **`GET …/v1/models`** (OpenAI-compatible model list) before running HTTP tests.
- With **nektos act**, the gitleaks SARIF upload step may need `HOME: ${{ github.workspace }}` because gitleaks-action uses `HOME` as the SARIF root and act mounts the repo at a host path instead of under `/home/runner`.
- With **nektos act**, **Upload SBOM** in CI may be gated with `if: ${{ env.ACT != 'true' }}` (generate SBOM still runs locally) because act’s artifact server can reject upload-artifact v7 payloads over a known `mime_type` mismatch.
