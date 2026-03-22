# Concepts

Glossary of terms used in auto-pr documentation and code.

| Term | Meaning |
|------|---------|
| **FC/IS** | Functional Core / Imperative Shell. The core (`src/core/*.ts`) contains pure functions returning `Result`; no Effect, no I/O. The shell (`src/auto-pr/shell.ts`) orchestrates I/O and bridges via `Effect.fromResult`. |
| **Tagless Final** | Effect idiom: define service interfaces (e.g. `FillPrTemplate`); implement as live interpreters in `live/`; tests swap mocks. |
| **Conventional commits** | Commit message format: `type(scope): subject` (e.g. `feat: add X`, `fix(scope): resolve Y`). See [conventionalcommits.org](https://www.conventionalcommits.org/). |
| **GITHUB_OUTPUT** | GitHub Actions mechanism for passing data between steps. Key-value pairs written to a file; subsequent steps read via `${{ steps.id.outputs.key }}`. |
| **GitHub App** | OAuth app for GitHub; creates tokens with repository permissions. auto-pr uses it for PR creation (not `GITHUB_TOKEN`) so PRs are attributed to the app. |
| **Two-phase workflow** | Split into generate (unprivileged checkout) and create (trusted checkout, PR write). Satisfies CodeQL/CWE-829; see [WORKFLOW_SECURITY.md](WORKFLOW_SECURITY.md). |
| **ai/* branch** | Branch name pattern that triggers the auto-pr workflow. Push to `ai/feature-x` → workflow creates/updates PR. |
| **Effect** | TypeScript library for typed functional programming. Used for error handling, dependency injection, and async. |
| **Result** | Type from `effect` or similar: `Ok(value)` or `Err(error)`. Core returns `Result`; shell bridges to `Effect`. |
| **Domain errors** | Tagged error classes live in `src/core/errors.ts`; `formatError` (shell) in `src/auto-pr/errors.ts`. Core defines, shell formats for logging. |
