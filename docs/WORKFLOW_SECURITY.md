# Auto-PR Workflow Security Model

This document describes the security model for the auto-pr GitHub Actions workflows. It addresses CWE-829 (Improper Control of a Resource Through its Lifetime) and related supply-chain concerns.

## Threat Model

When a workflow runs on a push to an `ai/*` branch, the pushed code may be from any collaborator or fork. An attacker could:

- Push malicious code that runs during the workflow (e.g. modified `package.json` scripts, build scripts)
- Poison artifacts that a privileged job later consumes
- Exfiltrate secrets if untrusted code runs with access to them

The goal is to **never execute untrusted code in a privileged context** (secrets, `pull-requests: write`).

## Two-Phase Design

The auto-pr flow is split into two reusable workflows:

| Workflow | Checkout | Permissions | Secrets |
|----------|----------|-------------|---------|
| **generate** (`auto-pr-generate-reusable.yml`) | Branch (`github.ref_name`) | `contents: read` | None |
| **create** (`auto-pr-create-reusable.yml`) | Default branch only | `contents: read`, `pull-requests: write` | `APP_ID`, `APP_PRIVATE_KEY` |

### Generate (Unprivileged)

- **Checkout:** The pushed branch — untrusted, but acceptable because the workflow has no privileged permissions.
- **Runs:** `auto-pr-get-commits`, `auto-pr-generate-content` (Ollama), artifact preparation.
- **Output:** Artifact `pr-content` (title, body, branch, default_branch).
- **Risk:** Limited. Even if the checked-out code is malicious, it cannot write to the repo or access secrets.

### Create (Privileged, Trusted Checkout Only)

- **Checkout:** `github.event.repository.default_branch` — trusted.
- **Input:** Artifact from generate job.
- **Runs:** GitHub App token generation, `gh pr create` or `gh pr edit`.
- **Risk:** Mitigated. No untrusted code is checked out or executed. Artifact content is treated as data, not code.

## Artifact Handling

The create workflow downloads the artifact produced by generate. Artifacts from unprivileged jobs are considered **untrusted data**:

- **Extraction:** Artifact is downloaded to `${{ runner.temp }}/pr-artifact` (not workspace) to avoid overwriting trusted files.
- **Usage:** Artifact files (title.txt, body.md, branch.txt, default_branch.txt) are read as data and passed to `gh`. No scripts from the artifact are executed.
- **Validation:** The create-or-update-pr CLI validates inputs before calling `gh`.

## CodeQL and Suppression

CodeQL flags "Checkout of untrusted code in trusted context" (CWE-829) when a workflow checks out potentially attacker-controlled refs while having privileged permissions. Our two-phase design satisfies the security intent:

- Generate: untrusted checkout, unprivileged context
- Create: trusted checkout only, privileged context

CodeQL may still report alerts on reusable workflows because it does not fully model cross-workflow permission separation. We exclude the untrusted-checkout query variants via [.github/codeql/codeql-config.yml](../.github/codeql/codeql-config.yml). The security model above is preserved; suppression only silences false positives.

## Related

- [ADR: Two Workflow Files for Auto-PR](adr/two-phase-auto-pr-workflow.md) — Design decision and alternatives
- [docs/CI.md](CI.md) — Workflow overview
- [GitHub: Keeping your GitHub Actions and workflows secure](https://securitylab.github.com/research/github-actions-preventing-pwn-requests/)
