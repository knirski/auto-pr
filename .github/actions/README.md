# GitHub Actions

Reusable workflows. See [docs/CI.md](../../docs/CI.md) for workflow structure.

| Workflow | Purpose | Called by |
|----------|---------|-----------|
| **check.yml** | Full check (test, lint, rumdl, typos, actionlint, shellcheck, SBOM via npm sbom) | ci.yml |
| **nix.yml** | Nix build + npmDepsHash update | ci-nix.yml, update-nix-hash.yml |
