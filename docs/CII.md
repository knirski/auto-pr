# CII Best Practices Badge — Progress

This project pursues the [OpenSSF Best Practices badge](https://www.bestpractices.dev/en) (formerly CII). Self-certify at [bestpractices.dev](https://www.bestpractices.dev/en/projects/new).

## Implemented

| Criterion area | Status | Notes |
|----------------|--------|-------|
| **Dependency management** | Done | bun audit in check script; Dependabot for npm and GitHub Actions |
| **Static analysis** | Done | CodeQL (security-extended); Biome |
| **SBOM** | Done | CycloneDX SBOM via bun x @cyclonedx/cyclonedx-npm in CI; artifact per run |
| **Token permissions** | Done | All workflows use explicit least-privilege permissions (`permissions: {}` or job-level overrides) |
| **Pinned actions** | Done | All workflow actions pinned by full commit hash |
| **Vulnerability reporting** | Done | SECURITY.md; GitHub Private Vulnerability Reporting |

## Next steps

- Complete self-assessment at bestpractices.dev
- Signed releases (if/when publishing to npm)
- Fuzzing (N/A for TypeScript)
