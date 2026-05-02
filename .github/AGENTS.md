# GitHub Automation Instructions

These rules apply to `.github/**`.

## Workflows

- Run `bun run lint:workflows` after editing workflow files.
- Run `bun run act` for workflow behavior changes when local Docker/act is available. For graph validation use `bun run act -- --dry-run <mode>`.
- `act-smoke.yml` intentionally uses a matrix: `--dry-run check` and `check-workflows`. Do not change it to `--dry-run check-workflows`.

## Pins

- Third-party `uses:` entries must use a full SHA and keep the version in a trailing comment, for example `actions/cache@<sha> # v5.0.4`.
- Self-references matching `knirski/auto-pr/...@` must use one full 40-character SHA that is an ancestor of the branch and contains every referenced path.
- Same-repo local action references like `./.github/actions/...` do not need a SHA.
- `.github/workflows/update-workflow-pins.yml` updates self-referential pins after merge when workflows or actions changed. It does not update third-party actions or Dockerfiles.
- The local llama image pin lives in `.github/llama-server/Dockerfile`; Dependabot owns routine tag bumps.

## Reusable Actions

- Put repo-owned reusable actions under `.github/actions/<name>/`.
- Shell entrypoints must follow `scripts/AGENTS.md`: `shellcheck`, `shfmt`, strict quoting, and no secret printing.
- Use explicit inputs for paths and secrets. Do not rely on hidden repository layout when a caller can pass the value.
- Reusable-workflow actions run inside adopter repositories. They must not require Bun, this repo's `node_modules`, or runtime imports from `src/**`.
- For auto-pr TypeScript/Effect workflow logic, prefer a packaged command in `src/workflow/` invoked through `auto-pr-run-command`; do not add generated JavaScript bundles under `.github/actions/**`.
- Do not stage root `dist/` for ordinary PRs; root `dist/` is owned by the dist update workflows.
