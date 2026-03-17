# setup-runtime

Composite action that sets up the JS/TS runtime matching the project's lockfile or `packageManager` field. Used by the auto-pr reusable workflows so callers don't need to copy or reimplement it.

## Detection order

`packageManager` (package.json) → lockfile → default node npx.

Supported: `bun.lock`, `bun.lockb`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`.

## Outputs

| Output    | Description                    |
|-----------|--------------------------------|
| `runner`  | Package runner: `npx` or `bunx` |
| `cache-hit` | Whether cache was restored    |

## Usage in reusable workflows

The auto-pr reusable workflows (`auto-pr-generate-reusable`, `check`) reference this action with a **full path**:

```yaml
uses: knirski/auto-pr/.github/actions/setup-runtime@<SHA>
```

**Why full path?** Reusable workflows run in the caller's repository. A relative path like `./.github/actions/setup-runtime` would resolve to the caller's repo, which doesn't have this action. The full path fetches the action from knirski/auto-pr, so callers need nothing extra.

**Pinning:** Use the same commit SHA as the workflow refs (see [auto-pr.yml](../../workflows/auto-pr.yml)). Update both when upgrading.

## Example: using in your own workflow

If you call the auto-pr reusable workflows, you get everything automatically—no setup needed.

If you use the [check workflow](../../workflows/check.yml) directly or build a custom workflow:

```yaml
steps:
  - uses: actions/checkout@v4
  - name: Setup runtime
    id: setup
    uses: knirski/auto-pr/.github/actions/setup-runtime@<SHA>
  - run: ${{ steps.setup.outputs.runner }} -p "$PKG" <cmd>
```

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `node-version-file` | `.nvmrc` | Path to Node version file |
| `bun-version` | (empty) | Bun version when bun detected; empty = auto |

## Troubleshooting

See [Wrong runtime (Node vs Bun) or cache not working](../../../docs/TROUBLESHOOTING.md#wrong-runtime-node-vs-bun-or-cache-not-working) in TROUBLESHOOTING.md.
