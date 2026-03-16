# GitHub Actions Workflow Best Practices Assessment

Research date: 2026-03-15. Assesses all `.github/workflows/*.yml` against modern best practices. Includes findings from respectable open-source projects (GitHub MCP, web).

## Current Setup Summary

| Practice | Status | Notes |
|----------|--------|-------|
| **Action pinning** | ✅ | SHA-pinned (e.g. `@de0fac2e... # v6.0.2`) |
| **Least privilege** | ✅ | `permissions: {}` or job-level overrides |
| **Concurrency** | ✅ | All workflows; `cancel-in-progress: true` except release-please (false) |
| **Timeouts** | ✅ | Jobs have timeout-minutes (10–20) |
| **Path filters** | ✅ | Built-in paths/paths-ignore, no third-party |
| **persist-credentials** | ✅ | Set false on read-only checkouts (check, check-docs, ci dependency-review, codeql) |
| **release-please** | ✅ | Documented in docs/CI.md workflows table |
| **Runner pinning** | ✅ | Uses `ubuntu-24.04` (x86), `ubuntu-24.04-arm` (arm64) for stability |

## Findings

### 1. persist-credentials (Security)

**Best practice** ([GitHub Actions security](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)): Set `persist-credentials: false` when checkout is read-only. Prevents token exposure to subsequent steps.

**Applied**: check.yml, check-docs.yml, ci.yml (dependency-review), codeql.yml. nix.yml and release-please need credentials for push; keep default.

**Open-source usage**: [hashicorp/vagrant](https://github.com/hashicorp/vagrant/blob/main/.github/workflows/code.yml) uses `persist-credentials: false` with `actions/checkout`. Scorecard workflow template also uses it. ~10k+ repos use this pattern.

### 2. Action Pinning

**Current**: All actions use full SHA, including `raven-actions/actionlint@205b530c5d9fa8f44ae9ed59f341a0db994aa6f8 # v2`.

**Open-source usage**: GitHub's security guide recommends full-length commit SHA as "the only way to use an action as an immutable release." Exercism docs require SHA pinning. [actions/starter-workflows](https://github.com/actions/starter-workflows) uses tags (v4) in some templates—less strict. hashicorp/vagrant uses SHA (`@8e8c483... # v6.0.1`).

### 3. Concurrency

**Best practice**: Add `concurrency` to avoid redundant runs and resource waste. Use `group` to scope by workflow and ref; use `cancel-in-progress: true` to cancel outdated runs.

**Applied**: All workflows have concurrency. Groups: `${{ workflow }}-${{ github.ref }}` for push/PR workflows; `stale`, `update-nix-hash` for single-run workflows. `release-please` uses `cancel-in-progress: false` to avoid cancelling a release in progress.

### 4. Runner Pinning (ubuntu-latest vs ubuntu-22.04)

**Exercism recommendation** ([gha-best-practices](https://github.com/exercism/docs/blob/main/building/github/gha-best-practices.md)): Use `ubuntu-22.04` instead of `ubuntu-latest` for build stability—same runner each run.

**Applied**: All workflows use `ubuntu-24.04` (x86) or `ubuntu-24.04-arm` (arm64 in nix matrix). Pinned runners ensure reproducible builds; bump when upgrading.

### 5. Documentation

- **docs/CI.md**: release-please.yml added to workflows table
- **ci-nix.yml**: Uses cachix/install-nix-action, cache-nix-action (see docs/adr/nix-ci-research.md)

### 6. Reusable Workflows

**Current**: check.yml, check-docs.yml, nix.yml are reusable. Good structure.

### 7. Dependency Review

**Current**: ci.yml runs dependency-review on PRs. Good.

### 8. CodeQL

**Current**: Security-extended queries, matrix for actions + javascript-typescript. Good.

### 9. OpenSSF Scorecard

**Current**: scorecard.yml runs on push to main and weekly (Saturday 01:30 UTC). Publishes results to code scanning (SARIF). Validates token permissions, pinned actions, and other supply-chain checks.

## Open-Source Project Comparison

| Project | persist-credentials | Action pinning | Concurrency | Timeouts | Runner |
|---------|---------------------|----------------|-------------|----------|--------|
| **hashicorp/vagrant** | ✅ false | SHA | — | — | ubuntu-latest |
| **vercel/next.js** | — | SHA | ✅ | ✅ | ubuntu-latest |
| **exercism/docs** | — | SHA (required) | ✅ | ✅ 30min | ubuntu-22.04 |
| **actions/starter-workflows** | — | Tags (v4) | — | — | ubuntu-latest |
| **auto-pr** | ✅ false | SHA | ✅ | ✅ 10–20min | ubuntu-24.04 |

## References

- [GitHub Actions security hardening](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)
- [actions/checkout persist-credentials](https://github.com/actions/checkout/issues/485)
- [GitHub Actions Best Practice 2025](https://suzuki-shunsuke.github.io/slides/github-actions-best-practice-2025)
- [Exercism GHA best practices](https://exercism.org/docs/building/github/gha-best-practices)
- [hashicorp/vagrant workflows](https://github.com/hashicorp/vagrant/tree/main/.github/workflows)
