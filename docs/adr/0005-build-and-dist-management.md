# Build Output and dist Management for Node-Only Installs

## Context and Problem Statement

auto-pr is consumed via `npx -p github:knirski/auto-pr auto-pr-init` and similar. GitHub fetches the repo as a tarball; there is no `npm publish` step. The package has `bin` entries pointing to compiled JS. Without a built `dist/`, Node users would need Bun or tsx to run TypeScript. How should we build and ship the package so Node-only installs work?

**Problem:** How do we provide runnable binaries for Node-only consumers while keeping local development and PRs clean (no noisy `dist/` diffs)?

## Considered Options

* **Ship source, run via tsx** — Add tsx to dependencies; users run `npx tsx src/...`. Works but adds runtime dependency and slower startup.
* **Commit dist/ in every PR** — Contributors build and commit dist. Simple but pollutes history and PR diffs.
* **dist/ in .gitignore + CI commits dist on main** — Local and PRs stay clean; update-dist workflow builds and commits dist on push to main when `src/` changes. Node installs use committed dist.
* **build-and-commit-dist on release only** — Dist only on release tags. Breaks `npx -p github:knirski/auto-pr#branch` for non-tagged refs.

## Decision Outcome

Chosen option: **"dist/ in .gitignore + CI commits dist on main"**, because it keeps contributor workflow clean (no dist in PRs) while ensuring Node-only installs from any ref (branch, tag, commit) get runnable JS. The update-dist workflow uses `git add -f dist/` to override .gitignore; add-dist-to-release-pr adds dist to release-please PRs so tags include it.

### Consequences

* Good: `npx -p github:knirski/auto-pr` and `npx -p github:knirski/auto-pr#v0.1.2` work without Bun.
* Good: Local `dist/` is gitignored; `bun run build` produces it; contributors do not commit it.
* Good: Lefthook pre-commit blocks staging `dist/` (scripts/check-no-dist.sh); prevents accidental commits.
* Good: Bun installs run `prepare` → `bun run build`; Node installs use committed dist.
* Minor: After branching from main, `bun run build` may show `modified: dist/` — do not commit; CI updates main.
* Note: Build uses Bun.build (scripts/build.ts); entrypoints from package.json bin; output `dist/workflow/`, `dist/tools/`, `dist/prompts/`.

## References

* [CI.md](../CI.md#dist-and-gitignore) — Dist workflow, loop prevention
* [build-plan-2026.md](supporting/build-plan-2026.md) — Research (tsdown vs Bun.build; implemented via Bun.build)
* Git: `ac03857 chore: untrack dist/ and add lefthook hook to block commits (#38)`, `f7c7454 feat(ci): add dist management for Node-only installs (#29)`
