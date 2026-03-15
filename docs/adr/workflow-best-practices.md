# GitHub Actions Workflow Best Practices Assessment

Research date: 2025-03-15. Assesses all `.github/workflows/*.yml` against modern best practices. Includes findings from respectable open-source projects (GitHub MCP, web).

## Current Setup Summary

| Practice | Status | Notes |
|----------|--------|-------|
| **Action pinning** | ✅ | SHA-pinned (e.g. `@de0fac2e... # v6.0.2`) |
| **Least privilege** | ✅ | `permissions: {}` or job-level overrides |
| **Concurrency** | ✅ | ci.yml, auto-pr.yml, ci-nix.yml use cancel-in-progress |
| **Timeouts** | ✅ | Jobs have timeout-minutes (10–20) |
| **Path filters** | ✅ | Built-in paths/paths-ignore, no third-party |
| **persist-credentials** | ✅ | Set false on read-only checkouts (check, check-docs, ci dependency-review, codeql) |
| **release-please** | ✅ | Documented in docs/CI.md workflows table |
| **Runner pinning** | ⚠️ | Uses `ubuntu-latest`; Exercism recommends `ubuntu-22.04` for stability |

## Findings

### 1. persist-credentials (Security)

**Best practice** ([GitHub Actions security](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)): Set `persist-credentials: false` when checkout is read-only. Prevents token exposure to subsequent steps.

**Applied**: check.yml, check-docs.yml, ci.yml (dependency-review), codeql.yml. nix.yml and release-please need credentials for push; keep default.

**Open-source usage**: [hashicorp/vagrant](https://github.com/hashicorp/vagrant/blob/main/.github/workflows/code.yml) uses `persist-credentials: false` with `actions/checkout`. Scorecard workflow template also uses it. ~10k+ repos use this pattern.

### 2. Action Pinning

**Current**: All actions use full SHA, including `raven-actions/actionlint@205b530c5d9fa8f44ae9ed59f341a0db994aa6f8 # v2`.

**Open-source usage**: GitHub's security guide recommends full-length commit SHA as "the only way to use an action as an immutable release." Exercism docs require SHA pinning. [actions/starter-workflows](https://github.com/actions/starter-workflows) uses tags (v4) in some templates—less strict. hashicorp/vagrant uses SHA (`@8e8c483... # v6.0.1`).

### 3. Runner Pinning (ubuntu-latest vs ubuntu-22.04)

**Exercism recommendation** ([gha-best-practices](https://github.com/exercism/docs/blob/main/building/github/gha-best-practices.md)): Use `ubuntu-22.04` instead of `ubuntu-latest` for build stability—same runner each run.

**Trade-off**: `ubuntu-latest` gets security updates automatically; pinned runners require manual bumps. Many projects (vercel/next.js, etc.) still use `ubuntu-latest`. **Deferred**: not critical for this repo.

### 4. Documentation

- **docs/CI.md**: release-please.yml added to workflows table
- **ci-nix.yml**: Uses cachix/install-nix-action, cache-nix-action (see docs/adr/nix-ci-research.md)

### 5. Reusable Workflows

**Current**: check.yml, check-docs.yml, nix.yml are reusable. Good structure.

### 6. Dependency Review

**Current**: ci.yml runs dependency-review on PRs. Good.

### 7. CodeQL

**Current**: Security-extended queries, matrix for actions + javascript-typescript. Good.

## Open-Source Project Comparison

| Project | persist-credentials | Action pinning | Concurrency | Timeouts | Runner |
|---------|---------------------|----------------|-------------|----------|--------|
| **hashicorp/vagrant** | ✅ false | SHA | — | — | ubuntu-latest |
| **vercel/next.js** | — | SHA | ✅ | ✅ | ubuntu-latest |
| **exercism/docs** | — | SHA (required) | ✅ | ✅ 30min | ubuntu-22.04 |
| **actions/starter-workflows** | — | Tags (v4) | — | — | ubuntu-latest |
| **auto-pr** | ✅ false | SHA | ✅ | ✅ 10–20min | ubuntu-latest |

## References

- [GitHub Actions security hardening](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)
- [actions/checkout persist-credentials](https://github.com/actions/checkout/issues/485)
- [GitHub Actions Best Practice 2025](https://suzuki-shunsuke.github.io/slides/github-actions-best-practice-2025)
- [Exercism GHA best practices](https://exercism.org/docs/building/github/gha-best-practices)
- [hashicorp/vagrant workflows](https://github.com/hashicorp/vagrant/tree/main/.github/workflows)
