# Composite Actions

Reusable actions for Nix-related CI workflows. Used by reusable workflows (check.yml, nix.yml) and standalone workflows (update-flake-lock.yml). See [docs/CI.md](../../docs/CI.md) for workflow structure.

## Structure

| Action | Purpose | Used by |
|--------|---------|---------|
| **nix-setup** | Checkout, install Nix | nix workflow, update-flake-lock |
| **nix-npm-deps-hash** | Run update-npm-deps-hash.sh, output hash when updated | nix workflow |
| **nix-commit-npm-deps-hash** | Commit and push npmDepsHash update | nix workflow |
| **nix-fail-npm-deps-hash-fork** | Fail with instructions for fork PRs | nix workflow |

## Reusable Workflows

| Workflow | Purpose | Called by |
|----------|---------|-----------|
| **check.yml** | Full check (test, lint, rumdl, typos, actionlint, shellcheck, SBOM) | ci.yml |
| **nix.yml** | Nix build + npmDepsHash update | ci-nix.yml, update-nix-hash.yml |
