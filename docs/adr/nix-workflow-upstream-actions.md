# ADR: Replacing nix.yml Steps with Upstream Actions

Research date: 2025-03-15. Assesses whether steps in `.github/workflows/nix.yml` can be replaced by third-party (upstream) GitHub Actions.

## Current Steps Overview

**hash job** (ubuntu-latest, runs first):

| Step | Current implementation | Purpose |
|------|------------------------|---------|
| 1 | `actions/create-github-app-token` | Generate App token for push |
| 2 | `actions/checkout` | Checkout repo with token passthrough |
| 3 | Custom `update-npm-deps-hash.sh` | Compute and output npmDepsHash |
| 4 | Inline `git config` + `git add` + `git commit` + `git push` | Commit and push default.nix |
| 5 | Inline `gh workflow run ci.yml --ref "$BRANCH"` | Trigger ci.yml after push |
| 6 | Inline fork failure message | Instruct user to update locally |

**build job** (matrix: ubuntu-latest, ubuntu-24.04-arm; depends on hash):

| Step | Current implementation | Purpose |
|------|------------------------|---------|
| 1 | `actions/checkout` | Checkout repo |
| 2 | `cachix/install-nix-action` | Install upstream Nix |
| 3 | `nix-community/cache-nix-action` | Cache Nix store (per-system key) |
| 4 | Inline `nix flake check -L --system ${{ matrix.system }}` | Build and run flake checks for x86_64-linux or aarch64-linux |

## Research Findings

### 1. Git commit + push (Step 7) — **Replaceable**

**Upstream action:** `stefanzweifel/git-auto-commit-action` (2,500+ stars)

- **Token handling:** No `token` input; uses credentials from `actions/checkout`. Pass App token via checkout `token`; keep `persist-credentials: true` (default).
- **File pattern:** `file_pattern: default.nix` commits only `default.nix`.
- **Commit message:** `commit_message: "fix(nix): update npmDepsHash for package-lock.json"`.
- **User/email:** Defaults to `github-actions[bot]`; matches current setup.

**Replacement:**

```yaml
- if: steps.hash.outputs.hash != '' && inputs.push_allowed
  uses: stefanzweifel/git-auto-commit-action@v7
  with:
    commit_message: "fix(nix): update npmDepsHash for package-lock.json"
    file_pattern: default.nix
    branch: ${{ steps.hash.outputs.branch }}
```

**Requirement:** Add `branch` output to the hash step (strip `refs/heads/` from ref) so git-auto-commit knows the target branch. The hash step already runs; add:

```yaml
echo "branch=${REF#refs/heads/}" >> "$GITHUB_OUTPUT"
```

with `REF: ${{ inputs.ref || github.ref }}` in env.

**References:**

- [stefanzweifel/git-auto-commit-action](https://github.com/stefanzweifel/git-auto-commit-action)
- [Issue #181](https://github.com/stefanzweifel/git-auto-commit-action/issues/181): Token via checkout
- [PR #13](https://github.com/stefanzweifel/git-auto-commit-action/pull/13): `file_pattern` input

---

### 2. Workflow trigger (Step 8) — **Keep as-is**

**Options:**

| Approach | Pros | Cons |
|----------|------|------|
| `gh workflow run` (current) | Built-in, no extra action, pre-installed on runners | Imperative |
| `benc-uk/workflow-dispatch` | Declarative, `wait-for-completion`, JSON inputs | Extra dependency, ~350 stars |
| `actions/github-script` | Official, flexible | More verbose, same outcome |

**Recommendation:** Keep `gh workflow run`. It is the common pattern; no benefit to switching.

---

### 3. npmDepsHash update — **Not replaceable (upstream Nix)**

**Current:** Custom `update-npm-deps-hash.sh` uses `prefetch-npm-deps` with upstream Nix. Works.

**Alternative:** `determinate-nixd fix hashes` would require Determinate Nix; not applicable for upstream Nix.

---

### 4. Other steps — **Already upstream or standard**

| Step | Status |
|------|--------|
| App token | `actions/create-github-app-token` — official |
| Checkout | `actions/checkout` — official |
| Install Nix | `cachix/install-nix-action` — standard for upstream Nix |
| Cache | `nix-community/cache-nix-action` — standard (per-system key) |
| Fork failure | Inline is appropriate; no generic action |
| `nix flake check --system` | No action wraps this; inline is standard. Matrix: x64 + arm64 runners |

---

## Summary

| Step | Replaceable? | Action |
|------|--------------|--------|
| Git commit + push | Yes | `stefanzweifel/git-auto-commit-action` |
| Workflow trigger | No | Keep `gh workflow run` |
| npmDepsHash | No (upstream Nix) | Keep custom script |
| Others | No | Already upstream or standard |
