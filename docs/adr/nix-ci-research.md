# Nix CI Research: Best Practices Assessment

Research date: 2025-03-15. Assesses `.github/actions/nix-*` and `.github/workflows/*nix*` against current best practices.

**Applied 2025-03-15:** Switched to cachix/install-nix-action, added cache-nix-action, consolidated checkout with token passthrough.

## Current Setup Summary

| Component | Current | Purpose |
|-----------|---------|---------|
| **Nix installer** | `cachix/install-nix-action@v25` | Install upstream Nix on runners |
| **Nix setup** | Custom composite action | Checkout + Nix install (token passthrough) |
| **Nix cache** | `nix-community/cache-nix-action@v7` | Cache /nix/store in GitHub Actions |
| **Flake checker** | `DeterminateSystems/flake-checker-action@v12` | Warn on outdated flake |
| **Update flake lock** | `DeterminateSystems/update-flake-lock@v28` | Weekly flake.lock updates |
| **npmDepsHash** | Custom script + actions | Auto-update default.nix hash |

## Findings

### 1. Determinate Nix Installer: Upstream Nix Deprecation (High Priority)

**Determinate Systems is dropping upstream Nix support** ([announcement](https://determinate.systems/blog/installer-dropping-upstream/)):

- **Nov 10, 2025**: Installer defaults to Determinate Nix; `--prefer-upstream-nix` still available
- **Jan 1, 2026**: Upstream Nix support ends; `--prefer-upstream-nix` removed

**Impact**: Your flake uses `nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable"` (upstream). The `nix-installer-action` will eventually install Determinate Nix only.

**Options**:
- **A) Switch to `cachix/install-nix-action`** — Community standard for upstream Nix (662 stars). Used by nix.dev docs. No deprecation.
- **B) Migrate to Determinate Nix** — [Migration guide](https://docs.determinate.systems/guides/migrating-from-upstream). Requires testing; Determinate Nix has different behavior.
- **C) Wait for community fork** — Nix Installer Working Group may publish upstream-only fork.

**Recommendation**: Switch to `cachix/install-nix-action@v25` before Jan 2026 for upstream Nix continuity.

### 2. Nix Store Caching (Medium Priority)

**Current**: No caching. Each run fetches from nixpkgs and builds from scratch.

**Best practice** (per [nix.dev CI guide](https://nixos.org/guides/continuous-integration-github-actions.html)):
- **Cachix** — Binary cache; push built derivations after job; substitute before build. Requires `CACHIX_SIGNING_KEY` / `CACHIX_AUTH_TOKEN` secrets. 5GB free for OSS.
- **nix-community/cache-nix-action** — Caches `/nix/store` in GitHub Actions cache. No secrets. Compatible with `cachix/install-nix-action` and `DeterminateSystems/determinate-nix-action`. Free, 10GB repo limit.

**Recommendation**: Add `nix-community/cache-nix-action@v7` for faster runs. Use `primary-key` based on `hashFiles('**/*.nix', '**/flake.lock')` to invalidate when Nix inputs change.

### 3. Duplicate Checkout in nix-setup (Low Priority)

**Current**: `nix.yml` does checkout (with App token when `push_allowed`), then `nix-setup` does checkout again (without token).

**Issue**: The second checkout uses default `GITHUB_TOKEN`, overwriting the first. For same-repo pushes, `GITHUB_TOKEN` can push, but its pushes don't trigger workflows—hence the separate `gh workflow run` step with App token. Flow is correct but redundant.

**Recommendation**: Add a `token` input to `nix-setup` and pass it through to `actions/checkout`, so the workflow can use a single checkout with the right token. Alternatively, have `nix-setup` skip checkout when the parent already checked out (e.g. `skip-checkout` input).

### 4. Action Pinning (Good)

**Current**: Actions pinned by full SHA (e.g. `de0fac2e4500dabe0009e67214ff5f5447ce83dd` for checkout v6.0.2). Matches supply-chain security best practice.

**Recommendation**: Keep SHA pinning.

### 5. Flake Structure (Good)

**Current**: Standard flake with `packages`, `devShells`, `apps`, `formatter`. Uses `nixos-unstable`. Single-system (`x86_64-linux`) is fine for CI.

**Recommendation**: Consider `nix-systems` for multi-system if you add macOS/ARM later. Not required for current setup.

### 6. update-flake-lock (Good)

**Current**: `DeterminateSystems/update-flake-lock` with conventional commit messages, labels, weekly schedule. Matches common usage.

**Recommendation**: No change.

### 7. npmDepsHash Automation (Good)

**Current**: Script + composite actions for hash update, fork detection, App-token push, workflow trigger. Handles same-repo vs fork correctly.

**Recommendation**: No change. Consider documenting the `gh workflow run` step (App token needed because `GITHUB_TOKEN` pushes don't trigger workflows).

### 8. Permissions (Good)

**Current**: Minimal permissions; `contents: write` only where needed for push. `permissions: {}` at workflow level with job-level overrides.

**Recommendation**: No change.

## Summary Table

| Area | Status | Action |
|------|--------|--------|
| Nix installer | ✅ Done | Switched to `cachix/install-nix-action@v25` |
| Caching | ✅ Done | Added `cache-nix-action@v7` |
| Checkout | ✅ Done | Consolidated; token passthrough in nix-setup |
| Pinning | ✅ Good | Keep SHA pinning |
| Flake | ✅ Good | No change |
| update-flake-lock | ✅ Good | No change |
| npmDepsHash | ✅ Good | No change |
| Permissions | ✅ Good | No change |

## References

- [nix.dev: Continuous integration with GitHub Actions](https://nixos.org/guides/continuous-integration-github-actions.html)
- [Determinate: Dropping upstream Nix](https://determinate.systems/blog/installer-dropping-upstream/)
- [nix-community/cache-nix-action](https://github.com/nix-community/cache-nix-action)
- [cachix/install-nix-action](https://github.com/cachix/install-nix-action)
- [Determinate GitHub Actions guide](https://docs.determinate.systems/guides/github-actions/)
