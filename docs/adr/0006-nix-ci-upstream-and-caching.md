# Nix CI: Upstream Nix and Store Caching

## Context and Problem Statement

CI runs Nix builds (`nix flake check`) for reproducible dev shells and multi-system checks. The Determinate Nix Installer announced it would drop upstream Nix support (Jan 1, 2026). We also had no Nix store caching, causing slow CI runs. Which Nix installer and caching strategy should we use?

**Problem:** How do we keep Nix CI fast and maintainable while respecting the upstream-Nix vs Determinate-Nix ecosystem shift?

## Considered Options

* **Determinate Nix** — Determinate Systems' installer; `determinate-nixd fix hashes` for hash automation. Upstream support ends Jan 2026; migration requires testing.
* **cachix/install-nix-action (upstream Nix)** — Community standard for upstream Nix; no deprecation. Used by nix.dev docs. Custom scripts for bun.nix hash updates.
* **No caching** — Each run fetches from nixpkgs. Simple but slow.
* **nix-community/cache-nix-action** — Caches `/nix/store` in GitHub Actions cache. No secrets; 10GB repo limit. Compatible with both installers.
* **Cachix binary cache** — Push/substitute derivations. Requires CACHIX_SIGNING_KEY; 5GB free for OSS. Extra setup.

## Decision Outcome

Chosen option: **"cachix/install-nix-action + nix-community/cache-nix-action"** (upstream Nix with GitHub Actions cache), because it provides continuity for upstream Nix without Determinate migration risk, and the cache action gives significant speedup without secrets or paid plans. We use custom `update-bun-nix` flow for bun.nix hash updates (upstream Nix does not have `determinate-nixd fix hashes`).

### Consequences

* Good: No dependency on Determinate installer deprecation timeline; upstream Nix remains supported.
* Good: cache-nix-action reduces build time; primary key based on Nix inputs for invalidation.
* Good: ci-nix runs `nix flake check -L` on matrix (x86_64-linux, aarch64-linux) via ubuntu-latest and ubuntu-24.04-arm.
* Bad: Must maintain custom bun.nix update logic; Determinate's `fix hashes` would simplify that if we migrate later.
* Note: [determinate-nix-migration-plan.md](supporting/determinate-nix-migration-plan.md) documents a future migration path if we switch to Determinate Nix.

## References

* [nix-ci-research.md](supporting/nix-ci-research.md) — Detailed assessment, findings
* [determinate-nix-migration-plan.md](supporting/determinate-nix-migration-plan.md) — Migration plan if switching to Determinate
* [CI.md](../CI.md) — ci-nix, update-bun-nix, update-flake-lock
