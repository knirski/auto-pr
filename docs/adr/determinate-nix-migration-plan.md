# Plan: Migrating to Determinate Nix

Research date: 2025-03-15. Outlines steps to switch from upstream Nix (`cachix/install-nix-action`) to Determinate Nix (`DeterminateSystems/determinate-nix-action`).

**Note:** This plan was written when auto-pr used npm and `npmDepsHash`. The project has since migrated to Bun and bun2nix (`bun.nix`). Phase 1.3 (npmDepsHash flow) is obsolete; the equivalent for bun is `bun.nix` auto-update in nix.yml. The Nix installer migration (Phases 1.1, 1.2) remains relevant.

## Context

- **Current:** Upstream Nix via `cachix/install-nix-action`, bun2nix for `bun.nix` (replaces legacy npmDepsHash).
- **Driver:** Determinate Nix Installer drops upstream support Jan 1, 2026. Migrating aligns with Determinate’s direction and enables `determinate-nixd fix hashes` for hash automation.
- **Scope:** CI workflows, local dev docs, flake apps. No change to `default.nix` or `buildNpmPackage` usage.

## Prerequisites

- [ ] Read [Migrating from upstream Nix](https://docs.determinate.systems/guides/migrating-from-upstream-nix/)
- [ ] Read [Automatically fix hashes in GitHub Actions](https://docs.determinate.systems/guides/automatically-fix-hashes-in-github-actions/)
- [ ] Ensure `APP_ID` and `APP_PRIVATE_KEY` secrets exist (unchanged)
- [ ] Create branch `ai/determinate-nix-migration`

---

## Phase 1: CI Workflows

### 1.1 Replace Nix installer in nix.yml

**Before:**

```yaml
- uses: cachix/install-nix-action@6004951b182f8860210c8d6f0d808ec5b1a33d28 # v25
  with:
    extra_nix_config: "experimental-features = nix-command flakes auto-allocate-uids"
```

**After:**

```yaml
- uses: DeterminateSystems/determinate-nix-action@v3
```

Determinate Nix enables flakes by default. Pin by full SHA per project policy.

### 1.2 Replace Nix installer in update-flake-lock.yml

Same change as 1.1.

### 1.3 Replace npmDepsHash flow with determinate-nixd fix hashes

**Current flow:**
1. Run `update-npm-deps-hash.sh` → outputs `hash` if changed
2. If hash changed and push_allowed: git config, add, commit, push
3. Trigger ci.yml
4. If hash changed and !push_allowed: fail with instructions
5. Run `nix build .#default`

**New flow (Determinate pattern):**
1. Run `nix build .#default` first (or `nix flake check -L`)
2. On failure **and** push_allowed: run `determinate-nixd fix hashes --auto-apply`, then commit/push if diff
3. Trigger ci.yml if we pushed
4. On failure **and** !push_allowed: fail with instructions
5. Re-run build (or run build before fix so we only fix when build fails)

**Alternative (closer to current flow):**
1. Run `determinate-nixd fix hashes --auto-apply` (always; no-op if hashes OK)
2. If `git diff` shows changes and push_allowed: commit, push, trigger ci
3. If changes and !push_allowed: fail with instructions
4. Run `nix build .#default`

The alternative avoids “build twice” and keeps the “fix first, then build” order. Use this unless Determinate’s “build first, fix on failure” is preferred.

**Implementation sketch:**

```yaml
- id: fix-hashes
  if: inputs.push_allowed
  run: |
    determinate-nixd fix hashes --auto-apply
    if ! git diff --quiet default.nix 2>/dev/null; then
      echo "hash_changed=true" >> "$GITHUB_OUTPUT"
    fi
  env:
    GITHUB_HEAD_REF: ${{ github.head_ref || '' }}

- if: steps.fix-hashes.outputs.hash_changed == 'true' && inputs.push_allowed
  # ... git commit, push, trigger ci (same as now)
```

**Fork case:** When !push_allowed, we still need to detect hash mismatch. Options:
- Run `nix build` first; on failure, show instructions (current behavior).
- Run `determinate-nixd fix hashes --auto-apply` (read-only, no push) and check diff; if changed, fail with instructions. This requires checkout with write access to the working tree even when we won’t push. Current workflow already has that.

### 1.4 Cache compatibility

- **nix-community/cache-nix-action:** Compatible with Determinate Nix ([nix-ci-research.md](nix-ci-research.md)). Keep as-is.
- **FlakeHub Cache:** Requires paid plan and `id-token: write`; not usable for fork PRs. Skip.

### 1.5 Permissions

- `determinate-nix-action`: no extra permissions.
- `contents: write` for push: unchanged.
- No `id-token` needed if we do not use FlakeHub Cache.

---

## Phase 2: Remove or Repurpose Custom Scripts

### 2.1 update-npm-deps-hash.sh

- **CI:** Replaced by `determinate-nixd fix hashes --auto-apply`.
- **Local:** Keep for contributors on upstream Nix during/after migration, or remove if we document Determinate Nix only.
- **Recommendation:** Keep script; document both `determinate-nixd fix hashes` and `nix run .#update-npm-deps-hash` in CONTRIBUTING.md.

### 2.2 Flake app `update-npm-deps-hash`

- **flake.nix:** Keep. Uses `prefetch-npm-deps` from nixpkgs; works with both upstream and Determinate Nix.
- **Purpose:** Fallback for contributors who prefer `nix run .#update-npm-deps-hash`.

### 2.3 update-nix-hash.ts

- **Purpose:** For contributors without Nix; takes hash as argument.
- **Action:** Keep unchanged.

### 2.4 check-nix-hash.sh

- **Purpose:** Pre-commit check; warns if package-lock.json changed and hash may be stale.
- **Action:** Keep. `nix run nixpkgs#prefetch-npm-deps` works with Determinate Nix.

---

## Phase 3: Documentation

### 3.1 README.md

- Add note: “CI uses Determinate Nix.”
- Update “Update deps hash” to mention both:
  - `determinate-nixd fix hashes --auto-apply` (with Determinate Nix)
  - `nix run .#update-npm-deps-hash` (works with either Nix)

### 3.2 CONTRIBUTING.md

- Add “Determinate Nix recommended” (or required for CI parity).
- Link to [migration guide](https://docs.determinate.systems/guides/migrating-from-upstream-nix/).
- Fork PR instructions: keep current text; ensure `determinate-nixd fix hashes` is mentioned as an option.

### 3.3 docs/CI.md

- State that Nix workflows use Determinate Nix.
- Note that `determinate-nixd fix hashes` replaces the previous hash-update script in CI.

### 3.4 docs/adr/nix-ci-research.md

- Update “Current Setup Summary” to list Determinate Nix.
- Mark migration as done in the summary table.

### 3.5 docs/adr/nix-workflow-upstream-actions.md

- Update npmDepsHash section: we now use `determinate-nixd fix hashes` instead of the custom script.

---

## Phase 4: Testing

### 4.1 CI validation

- [ ] Push to a test branch; confirm nix build passes.
- [ ] Change `package-lock.json` (e.g. add a dev dep); confirm hash is updated and pushed.
- [ ] Open PR from fork; confirm hash mismatch fails with clear instructions.
- [ ] Run `update-flake-lock` manually; confirm it succeeds.
- [ ] Run `update-nix-hash` manually; confirm it succeeds.

### 4.2 Local validation

- [ ] On a machine with Determinate Nix: `nix build .#default`, `nix run .#update-npm-deps-hash`, `determinate-nixd fix hashes --auto-apply`.
- [ ] On a machine with upstream Nix (if still supported): `nix run .#update-npm-deps-hash`.
- [ ] `npm run check` passes.

---

## Phase 5: Rollback

If migration causes issues:

1. Revert workflow changes (restore `cachix/install-nix-action`, `update-npm-deps-hash.sh`, and inline git block).
2. Revert doc changes.
3. Document rollback in this ADR.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Determinate Nix behavior differs from upstream | Test on branch before merging; keep rollback steps. |
| Cache misses after switch | First run may rebuild; cache key unchanged. |
| Contributors on upstream Nix | Keep `nix run .#update-npm-deps-hash` and docs. |
| determinate-nixd not in PATH | `determinate-nix-action` installs it; verify in CI. |

---

## References

- [Migrating from upstream Nix](https://docs.determinate.systems/guides/migrating-from-upstream-nix/)
- [Automatically fix hashes in GitHub Actions](https://docs.determinate.systems/guides/automatically-fix-hashes-in-github-actions/)
- [Determinate in GitHub Actions](https://docs.determinate.systems/guides/github-actions/)
- [DeterminateSystems/determinate-nix-action](https://github.com/DeterminateSystems/determinate-nix-action)
- [Dropping upstream Nix (announcement)](https://determinate.systems/blog/installer-dropping-upstream/)
