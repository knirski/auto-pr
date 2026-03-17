# ADR: Automated Update of Self-Referential Workflow Pins

## Context and Problem Statement

Workflows and composite actions in this repo reference themselves via `knirski/auto-pr/<path>@<SHA>` to pin to a specific commit. When workflows or actions change on main, those pins become stale: they point to older commits that may lack the latest fixes or behavior. How should we keep pins up to date?

## Considered Options

* **Option 1: Manual updates** — Contributors update pins when merging PRs that touch workflows. Documented in CONTRIBUTING and pr-workflow rule. Simple but error-prone; pins are often forgotten.
* **Option 2: PR check (check_only)** — Add a CI job that runs the update logic in `check_only` mode and fails when pins are stale. Catches the problem before merge but requires manual fix and re-push.
* **Option 3: Composite action on push to main** — Workflow runs on push to main when `.github/workflows/**` or `.github/actions/**` change. Updates pins to the current commit and pushes. Loop prevention via commit-message check.

## Decision Outcome

Chosen option: **"Composite action on push to main"** (Option 3), because it removes the manual step entirely. Pins are updated automatically when relevant files change; no contributor action required. Loop prevention (skip when commit message starts with `chore(workflows): update self-referential pins`) avoids infinite runs.

### Consequences

* Good: Zero manual maintenance — pins stay current on every merge that touches workflows or actions.
* Good: Same pattern as update-bun-nix and ci-nix — GitHub App token for push so workflows trigger on the new commit.
* Good: Path filter limits runs to when workflows/actions actually change.
* Good: `check_only` input available for future PR job if we want to fail CI when pins are stale before merge.
* Minor: Fork PRs — automation only runs in knirski/auto-pr; forks must update pins manually or run workflow_dispatch if they have the secrets.
* Note: workflow_dispatch supported for manual runs when automation didn't trigger (e.g. merge only touched `src/`).
