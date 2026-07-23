# Auto-PR Workflow Security Model

This document describes the security model for the auto-pr GitHub Actions workflows. It addresses CWE-829 (Improper Control of a Resource Through its Lifetime) and related supply-chain concerns.

## Threat Model

When a workflow runs on a push to an `ai/**` branch, the pushed code may be from any collaborator or fork. An attacker could:

- Push malicious code that runs during the workflow (e.g. modified `package.json` scripts, build scripts)
- Poison artifacts that a privileged job later consumes
- Exfiltrate secrets if untrusted code runs with access to them

The goal is to **never execute untrusted code in a privileged context** (secrets, `pull-requests: write`).

## Two-Phase Design

The auto-pr flow is split into two reusable workflows:

| Workflow | Checkout | Permissions | Secrets |
|----------|----------|-------------|---------|
| **generate** (`auto-pr-generate-reusable.yml`) | Branch (`github.ref_name`) | `contents: read`, `models: read` | `GH_TOKEN` from caller for GitHub Models; stock workflow passes `github.token` |
| **create** (`auto-pr-create-reusable.yml`) | No checkout | `contents: read`, `pull-requests: write` | `APP_ID`, `APP_PRIVATE_KEY` |

The **entry** workflow ([`auto-pr.yml`](../.github/workflows/auto-pr.yml)) must also include `models: read` in its top-level `permissions` when it calls the generate reusable workflow. Nested jobs cannot request broader `GITHUB_TOKEN` permissions than the caller grants ([reusable workflows and permissions](https://docs.github.com/en/actions/using-workflows/reusing-workflows#supported-keywords-for-jobs-that-call-a-reusable-workflow)).

### Generate (Unprivileged)

- **Checkout:** The pushed branch — untrusted, but acceptable because the workflow has no privileged permissions.
- **Runs:** model routing context classification, `auto-pr-generate-content` (AI), artifact preparation.
- **Output:** Artifact `pr-content` (title, body, branch, default_branch).
- **Risk:** Limited. It cannot write to the repo. The stock workflow passes the ephemeral default **`github.token`** with `models: read`, not a long-lived PAT and not the App install secrets (`APP_ID` / `APP_PRIVATE_KEY`). Custom workflows should not forward repository secrets to generate unless branch authors are trusted to see them.

### Create (Privileged, Trusted Checkout Only)

- **Checkout:** None. The job installs the trusted auto-pr package and uses only the downloaded artifact as data.
- **Input:** Artifact from generate job.
- **Runs:** GitHub App token generation, auto-pr create/update workflow (Octokit-backed PR client).
- **Risk:** Mitigated. No untrusted code is checked out or executed. Artifact content is treated as data, not code. The create workflow validates artifact `branch` and `default_branch` against the triggering ref and repository default before calling the GitHub API.

## Artifact Handling

The create workflow downloads the artifact produced by generate. Artifacts from unprivileged jobs are considered **untrusted data**:

- **Extraction:** Artifact is downloaded to `${{ runner.temp }}/pr-artifact` (not workspace) to avoid overwriting trusted files.
- **Usage:** Artifact files (title.txt, body.md, branch.txt, default_branch.txt) are read as data and passed to the PR client. No scripts from the artifact are executed.
- **Validation:** The create-or-update-pr CLI validates inputs before calling the GitHub API.

## CodeQL Coverage

CodeQL flags "Checkout of untrusted code in trusted context" (CWE-829) when a workflow checks out potentially attacker-controlled refs while having privileged permissions.

The `actions/untrusted-checkout-{critical,high,medium}` queries are **enabled with no repo-wide suppression**. The previous blanket exclusion in [.github/codeql/codeql-config.yml](../.github/codeql/codeql-config.yml) was removed: it rested on ADR 0002's superseded claim that the two-reusable-file split was a trust boundary CodeQL "could not model." Under [ADR 0016](adr/0016-immutable-privileged-workflow-executor.md) the design is genuinely sound rather than merely CodeQL-shaped — the privileged create phase is a default-branch-controlled `workflow_run` executor that performs **no checkout** and installs only a SHA-pinned executor, so no privileged job ever checks out an attacker-influenceable ref. There is nothing repo-wide left to suppress.

Two narrow, per-line inline suppressions remain, each on an **unprivileged** checkout that CodeQL flags as a false positive because it analyzes reusable workflows without caller context:

- `auto-pr-generate-reusable.yml` (generate job): checks out an explicit, caller-resolved head SHA with read-only permissions and no privileged secret; its only output is the data-only artifact.
- `nix.yml` (build job): `contents: read` only, no secrets, no `environment:`; the App-secret path lives solely in the separate `bun-nix-push` job.

Each carries a `# codeql[actions/untrusted-checkout]` comment stating its specific justification. No new suppression is added without a documented, reviewed proof of safety for a specific flagged result.

## Related

- [ADR 0016: Immutable privileged workflow executor](adr/0016-immutable-privileged-workflow-executor.md) — Current same-repository trust boundary (supersedes ADR 0002's trust rationale)
- [ADR 0002: Two-Phase Auto-PR Workflow](adr/0002-two-phase-auto-pr-workflow.md) — Original design decision and alternatives (trust rationale superseded)
- [ADR 0014: Replace gh PR wrapper with Octokit](adr/0014-replace-gh-pr-wrapper-with-octokit.md) — Privileged PR client transport
- [ADR 0015: Packaged model routing context command](adr/0015-packaged-model-routing-context-command.md) — Generate-job routing context command design
- [docs/CI.md](CI.md) — Workflow overview
- [GitHub: Keeping your GitHub Actions and workflows secure](https://securitylab.github.com/research/github-actions-preventing-pwn-requests/)
