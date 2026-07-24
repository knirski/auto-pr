# Two-Phase Auto-PR Workflow (CodeQL Without Suppression)

## Status

**Partially superseded by [ADR 0016](0016-immutable-privileged-workflow-executor.md).** The two-reusable-file split described here satisfies CodeQL's file-level analysis and that rationale still holds, but it was mistakenly treated as a *trust* boundary. Because the `push`-triggered entry workflow is evaluated from the pushed (untrusted) branch's own revision, a same-repository branch author controls the workflow definition, its `permissions:` blocks, and the package ref the privileged `create` job installs — a same-repository privilege escalation to code execution under the GitHub App token. ADR 0016 replaces the same-run trust model with a default-branch-controlled immutable privileged executor. Treat the design below as historical for anything trust-related.

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

* Good: Security model satisfied — generate unprivileged, create trusted checkout only.
* Good: Single push trigger; no workflow_run.
* Minor: Branch protection requires two checks (`Auto-PR generate (reusable) / generate`, `Auto-PR create (reusable) / create`).
* Minor: Entry workflow (auto-pr.yml) has two jobs instead of one.
* Note: CodeQL may still flag reusable workflows; see [docs/WORKFLOW_SECURITY.md](../WORKFLOW_SECURITY.md).
