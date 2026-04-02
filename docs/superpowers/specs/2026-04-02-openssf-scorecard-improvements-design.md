# OpenSSF Scorecard Improvements

Increase the OpenSSF Scorecard from 6/10 to 8-9/10 by fixing actionable checks and documenting future work.

**Baseline (2026-04-02):** <https://scorecard.dev/viewer/?uri=github.com/knirski/auto-pr>

| Score | Check |
|-------|-------|
| 10 | Binary-Artifacts, CI-Tests, Dangerous-Workflow, Dependency-Update-Tool, License, Security-Policy, Vulnerabilities |
| 9 | Pinned-Dependencies, SAST |
| 5 | Branch-Protection |
| 0 | Code-Review, CII-Best-Practices, Contributors, Fuzzing, Maintained, Token-Permissions |
| -1 | Packaging, Signed-Releases |

## 1. Token-Permissions (0 -> 10) — workflow changes

The scorecard requires workflow-level permissions to be read-only or empty. Write permissions must be at job-level only.

### Changes

**`add-dist-to-release-pr.yml`** — Move `contents: write, pull-requests: read` from workflow-level to job-level. Set workflow-level to `permissions: {}`.

**`stale.yml`** — Move `issues: write, pull-requests: write` from workflow-level to job-level. Set workflow-level to `permissions: {}`.

**`auto-pr.yml`** — Set workflow-level to `permissions: {}`. The caller workflow permissions cap nested reusable workflows, so each calling job must declare the permissions its callee needs:
- `generate` job: `contents: read, models: read`
- `create` job: `contents: read, pull-requests: write`

**`auto-pr-create-reusable.yml`** — Set workflow-level to `permissions: {}`. The job already has correct permissions (`contents: read, pull-requests: write`).

## 2. Pinned-Dependencies (9 -> 9) — no changes

The scorecard flags `npmCommand not pinned by hash` for `bun install`, `npm install`, and `bun add` in `run:` steps. There is no SHA-pinned action equivalent of these commands. `--frozen-lockfile` already ensures reproducibility. The `bun add` in `auto-pr-create-reusable.yml` installs a validated package ref intentionally.

Accept 9/10. No changes needed.

## 3. SAST (9 -> 10) — no changes

One of the last 12 commits was merged without CodeQL analysis. This self-heals as new commits go through CI. All current PR paths trigger CodeQL. No changes needed.

## 4. Branch-Protection (5 -> 8+) — GitHub settings

Manual changes in GitHub repository settings for `main` branch:

1. **Require a pull request before merging** with minimum 1 approval
2. **Do not allow bypassing the above settings** (includes admins)
3. **Require status checks to pass before merging** — require the CI workflow
4. **Require conversation resolution before merging** (not scored, but good practice)

These settings also improve Code-Review: once approvals are required, self-approvals on bot-created PRs count as approved changesets.

## 5. Code-Review (0 -> 7+) — process change

PRs are created by the auto-pr bot. The maintainer self-approves before merging. Once branch protection requires approvals (section 4), the scorecard will detect approved changesets. No workflow changes needed — this is a consequence of the branch protection settings.

The score improves gradually as the ratio of approved-to-total changesets increases over the last 30 commits.

## 6. CII Best Practices Badge (0 -> 10) — manual registration

1. Register at <https://www.bestpractices.dev/en/projects/new>
2. Complete the self-assessment questionnaire (most criteria already met per `docs/CII.md`)
3. Add the badge URL to `README.md`
4. Update `docs/CII.md` to link to the badge

## 7. Signed-Releases (-1 -> 10) — future, next release cycle

Add to the release workflow when cutting the next release:

1. **SLSA provenance** — Add `slsa-framework/slsa-github-generator` as a job after release creation. Produces a signed attestation linking the release artifact to a specific commit.
2. **Artifact signing** — Use `gh attestation` or `sigstore/cosign` to sign release artifacts.

If publishing to npm (see section 9), `npm publish --provenance` satisfies this check automatically.

## 8. Fuzzing (0 -> 10) — future guidelines

Low ROI today — the project is a TypeScript GitHub Action CLI, not a parser or security-critical library.

### When to implement

When the project grows to include input parsing with complex grammars (e.g., structured commit message parsing, user-provided config files, template engines).

### Implementation path

1. **Engine:** Use [ClusterFuzzLite](https://google.github.io/clusterfuzzlite/) — runs in GitHub Actions, no upstream OSS-Fuzz onboarding needed.
2. **Fuzzer:** Use [Jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js) as the JavaScript/TypeScript fuzzing engine.
3. **Targets:** Write fuzz targets for input-parsing functions (commit message parsing, template rendering, config validation).
4. **Config:** Add `.clusterfuzzlite/` directory with project configuration.
5. **Workflow:** Add a scheduled CI workflow that runs fuzz targets. ClusterFuzzLite provides a reusable workflow for this.

### Scorecard detection

The scorecard checks for either:
- A project registered in [OSS-Fuzz](https://github.com/google/oss-fuzz) (heavier, requires upstream PR)
- A `.clusterfuzzlite/` directory with a CI workflow (lighter, self-contained)

## 9. Packaging (-1 -> 10) — future guidelines

Currently consumed via `npx -p github:knirski/auto-pr` directly from the repo. No registry publication.

### When to implement

When the project is ready for broader distribution via npm or GitHub Packages.

### Implementation path

1. Add an npm publish job to `release-please.yml` triggered after a release is created.
2. Use `npm publish --provenance` — this generates SLSA provenance automatically, satisfying both Packaging and Signed-Releases checks.
3. Ensure `package.json` has correct `name`, `files`, `main`/`exports` fields.
4. Pin the `actions/setup-node` action by SHA and use `NODE_AUTH_TOKEN` from repository secrets.
5. Consider publishing to GitHub Packages as well for GitHub-native consumers.

### Scorecard detection

The scorecard looks for a GitHub Actions workflow that calls a known package publish action (e.g., `npm publish`, `actions/setup-node` with `registry-url`).

## Summary

### Immediate work (code/workflow changes)

| Item | Check | Expected score |
|------|-------|---------------|
| Move write permissions to job-level in 4 workflows | Token-Permissions | 0 -> 10 |

### Manual steps (GitHub settings / external services)

| Item | Check | Expected score |
|------|-------|---------------|
| Configure branch protection rules | Branch-Protection | 5 -> 8+ |
| Self-approve PRs before merging | Code-Review | 0 -> 7+ (gradual) |
| Register CII Best Practices badge | CII-Best-Practices | 0 -> 10 |

### Future work (next release / when relevant)

| Item | Check | Expected score |
|------|-------|---------------|
| SLSA provenance on releases | Signed-Releases | -1 -> 10 |
| ClusterFuzzLite + Jazzer.js | Fuzzing | 0 -> 10 |
| npm publish with provenance | Packaging | -1 -> 10 |

### No changes needed

| Check | Score | Reason |
|-------|-------|--------|
| Pinned-Dependencies | 9 | Package manager commands can't be SHA-pinned |
| SAST | 9 | Self-heals as new commits go through CodeQL |
| Maintained | 0 | Time-based, improves with sustained activity |
| Contributors | 0 | Organic, requires external contributors |
