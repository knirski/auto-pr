# CII Best Practices Badge — Progress

This project pursues the [OpenSSF Best Practices badge](https://www.bestpractices.dev/en) (formerly CII). Self-certify at [bestpractices.dev](https://www.bestpractices.dev/en/projects/new).

## Implemented

| Criterion area | Status | Notes |
|----------------|--------|-------|
| **Dependency management** | Done | bun audit in check script; Dependabot for Bun and GitHub Actions |
| **Static analysis** | Done | CodeQL (security-extended); Biome |
| **SBOM** | Done | CycloneDX SBOM via native npm sbom in CI; artifact per run |
| **Token permissions** | Done | All workflows use `permissions: {}` at workflow-level; write permissions at job-level only |
| **Pinned actions** | Done | All workflow actions pinned by full commit hash |
| **Vulnerability reporting** | Done | SECURITY.md; GitHub Private Vulnerability Reporting |

## Next steps

- Register at bestpractices.dev and complete self-assessment
- Add badge to README.md once registered
- Signed releases with SLSA provenance (when publishing to npm)
- Fuzzing with ClusterFuzzLite + Jazzer.js (when input parsing complexity warrants it)
