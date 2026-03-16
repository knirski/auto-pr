# ADR: Two Workflow Files for Auto-PR (CodeQL Without Suppression)

## Context and Problem Statement

CodeQL flags "Checkout of untrusted code in trusted context" (CWE-829) when a workflow checks out untrusted code (e.g. `${{ github.ref_name }}`) while having privileged permissions (secrets, `pull-requests: write`). CodeQL analyzes at the workflow-file level; job-level permission separation within a single file does not satisfy the query.

## Considered Options

* **Option 1: Suppress via CodeQL config** — Exclude the query. Zero user friction but suppresses the warning.
* **Option 2: workflow_run** — Unprivileged workflow (push) + privileged workflow (workflow_run). Resolves CodeQL but adds init complexity, two workflow runs.
* **Option 3: Two jobs in single workflow file** — Generate job (unprivileged) + create job (privileged). CodeQL still flags; it does not distinguish job-level permissions.
* **Option 4: Two separate reusable workflow files** — auto-pr-generate-reusable.yml (unprivileged only) + auto-pr-create-reusable.yml (privileged, trusted checkout only). Entry workflow (auto-pr.yml) has two jobs calling each. Resolves CodeQL; single push trigger.

## Decision Outcome

Chosen option: **"Two separate reusable workflow files"** (Option 4), because CodeQL analyzes each workflow file independently. The generate file has no privileged context; the create file has no untrusted checkout. Minimal user friction (two status checks for branch protection; same push trigger).

### Consequences

* Good: CodeQL passes; no suppression.
* Good: Single push trigger; no workflow_run.
* Minor: Branch protection requires two checks (`Auto-PR generate (reusable) / generate`, `Auto-PR create (reusable) / create`).
* Minor: Entry workflow (auto-pr.yml) has two jobs instead of one.
