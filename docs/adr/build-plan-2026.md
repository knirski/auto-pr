# Plan: Idiomatic TypeScript Build for auto-pr (2026)

**Status:** Implemented  
**Date:** 2026-03-16  
**Context:** Fix CI failure when package used as dependency; adopt standard build-before-publish pattern.

**Optimality:** tsdown is the best fit for 2026: Rolldown-based (2–8× faster than tsup), ESM-first, auto-reads `engines.node`. Alternatives (pkgroll, bunup) either complicate our path-alias/copy setup or require Bun. The plan incorporates gaps (prompt copy, npmDepsHash, .nvmrc in files) and modern tips (tsdown option names, `sideEffects`, migration path).

## Research Summary

### Build tools (2026)

| Tool | Downloads | Notes |
|------|-----------|-------|
| **tsup** | ~6M/wk | Zero-config, esbuild-based, ESM+CJS+dts. [PkgPulse 2026](https://www.pkgpulse.com/blog/tsup-vs-tsdown-vs-unbuild-typescript-library-bundling-2026) |
| **tsdown** | ~500K/wk | Rolldown-based, 3-5× faster, tsup-compatible API. Native `alias` option; `--from-vite vitest` reuses path resolution. |
| **unbuild** | ~3M/wk | UnJS ecosystem, stub mode. Not relevant here. |

**Choice:** tsdown — faster, modern, path aliases via `alias` or `--from-vite vitest`.

### Similar projects

- **tsx** ([privatenumber/tsx](https://github.com/privatenumber/tsx)): Uses pkgroll, ships `dist/` only, `files: ["dist"]`, `prepack: "pnpm build"`
- **Caporal.js** ([mattallty/Caporal.js](https://github.com/mattallty/Caporal.js)): CLI framework, tsup with `format: ["cjs","esm"]`, `dts: true`, `sourcemap: true`, `files: ["dist/**/*.{ts,js,mts,mjs,map}"]`
- **actions/upload-artifact**: Uses tsc + ncc (Vercel bundler), `main: "dist/upload/index.js"`
- **egoist/tsup**: `prepublishOnly: "pnpm run build"`, bins point to `dist/*.js`

### Critical practice

**Type checking:** Bundlers (tsup, tsdown) do not type-check. Run `tsgo --noEmit` separately.

### Alternatives considered (2026)

| Tool | Fit | Why not chosen |
|------|-----|----------------|
| **tsdown** | ✓ Chosen | Rolldown-based, 2–8× faster than tsup, ESM-first, auto-reads `engines.node`, tsup-compatible API. Best for new projects. |
| **tsup** | Good fallback | ~6M/wk, battle-tested. Default CJS; we want ESM. Use if tsdown has issues. |
| **pkgroll** | Partial | package.json-driven, no config file. Complex path aliases and copy needs may require workarounds. tsx uses it. |
| **unbuild** | UnJS ecosystem | Rollup-based, slower. mkdist for source dist not needed. |
| **bunup** | Too new | 37ms builds, but requires Bun runtime. Consumers use `npx`/npm; Bun not universal yet. |

---

## Implementation Plan

### Phase 1: Add build infrastructure

1. **Install tsdown**

   ```bash
   npm install -D tsdown
   ```

2. **Create `tsdown.config.ts`**
   - Entry points: 6 scripts — 5 bins + `run-auto-pr` (used by default.nix). Use explicit `entry` mapping to preserve `src/workflow/` → `dist/workflow/` and `src/tools/` → `dist/tools/` structure.
   - Format: ESM only (package has `"type": "module"`)
   - Target: `node24` (match engines)
   - Sourcemap: true
   - Clean: true
   - No dts for CLI entries (consumers run JS; types not needed at runtime)
   - **Path aliases:** Use `alias` from tsconfig paths, or `tsdown --from-vite vitest` in build script to reuse vitest's `vite-tsconfig-paths` plugin.
   - **Prompt at runtime:** `getPrDescriptionPromptPath` resolves `prompts/pr-description.txt` relative to the shared chunk (in `dist/`). Add `copy: [{ from: "src/auto-pr/prompts/**", to: "dist/prompts", flatten: true }]` so the prompt is at `dist/prompts/pr-description.txt`.

3. **Update `package.json` scripts**
   - `"build": "tsdown"` (or `"tsdown --from-vite vitest"` if using Vitest for path resolution)
   - `"prepublishOnly": "npm run build"`
   - Keep `typecheck` in check:code (bundlers do not type-check)

### Phase 2: Update package structure

4. **Change `bin` to point to `dist/`**
   - `auto-pr-get-commits` → `./dist/workflow/auto-pr-get-commits.mjs`
   - `auto-pr-generate-content` → `./dist/workflow/auto-pr-generate-content.mjs`
   - `auto-pr-create-or-update-pr` → `./dist/workflow/auto-pr-create-or-update-pr.mjs`
   - `auto-pr-fill-pr-template` → `./dist/tools/auto-pr-fill-pr-template.mjs`
   - `auto-pr-init` → `./dist/tools/auto-pr-init.mjs`
   - (run-auto-pr: no bin; Nix runs `node dist/workflow/auto-pr-run.mjs`)
   - **Note:** tsdown outputs `.mjs` for ESM (package has `"type": "module"`).

5. **Add `files` field**
   - `["dist", ".github", "docs", ".nvmrc"]` — init copies `.nvmrc` from the package. `dist/` includes `workflow/`, `tools/`, `prompts/`. Add other assets if needed at runtime.

6. **Remove**
   - `bin/*.mjs` (all 5 wrappers + run-ts.mjs)
   - `tsx` from dependencies (move to devDependencies for dev scripts)

### Phase 3: GitHub installs

7. **Commit `dist/`**
   - Required for `npx -p github:knirski/auto-pr#branch` — tarball includes repo contents
   - Do NOT add `dist/` to `.gitignore`
   - Add `npm run build` to `check:code` so dist is built before tests; contributors commit dist when it changes

8. **Update `check:code`**

   ```json
   "check:code": "npm run build && npm audit --audit-level=high && run-p lint knip typecheck && npm run test"
   ```

### Phase 4: Nix and CI

9. **default.nix**
   - `installPhase` currently copies `src` and runs `npx tsx src/workflow/run-auto-pr.ts`
   - Change to: copy `dist` (not `src`), `package.json`, `package-lock.json`, `node_modules`, `.github`; run `node dist/workflow/auto-pr-run.mjs`. Example:

     ```nix
     cp -r package.json package-lock.json node_modules dist .github $out/lib/node_modules/auto-pr/
     ...
     exec node dist/workflow/auto-pr-run.mjs "$@"
     ```

   - `npmBuildScript = "build"` already runs build; `dist/` exists in the build directory after build phase.

10. **npmDepsHash**
    - After adding tsdown and moving tsx to devDependencies, run `npm run update-npm-deps-hash` (or `nix run .#update-npm-deps-hash`) and commit the updated `npmDepsHash` in `default.nix`.

11. **CI**
    - check job already runs check:code; build will run as first step
    - No workflow changes needed

### Phase 5: Documentation

12. **AGENTS.md**
    - Update "Build/typecheck" to mention tsdown build
    - Remove "No build step; scripts run via tsx"

13. **CONTRIBUTING.md**
    - Note: run `npm run build` when changing src; commit dist if changed

---

## File changes summary

| File | Action |
|------|--------|
| `tsdown.config.ts` | Create (entry mapping, copy prompts, alias or --from-vite vitest) |
| `biome.json` | Exclude `dist` from lint (generated output) |
| `package.json` | build, prepublishOnly, bin, files: ["dist", ".github", "docs", ".nvmrc"], tsx→devDeps |
| `bin/*.mjs` | Delete (6 files) |
| `check:code` | Prepend `npm run build` |
| `.gitignore` | Do NOT add dist |
| `default.nix` | Update installPhase (copy dist not src, run node), update npmDepsHash |
| `AGENTS.md` | Update build note |
| `CONTRIBUTING.md` | Add build/commit note |

---

## Modern tips and tricks

- **tsdown defaults:** Format is ESM (we want that). Target auto-reads from `engines.node` in package.json. `clean: true` by default.
- **tsdown vs tsup option names:** Use `copy` not `publicDir`; use `deps.neverBundle` not `external`; use `deps.alwaysBundle` not `noExternal`. See [tsdown migrate guide](https://tsdown.dev/guide/migrate-from-tsup).
- **`sideEffects: false`:** Add to package.json if the package has no side effects. Enables better tree-shaking for consumers. Effect-based code may have side effects; verify before adding.
- **isolatedDeclarations:** If we ever emit `.d.ts` for library consumers, TypeScript 5.5+ `isolatedDeclarations` can speed up declaration generation (tsdown supports it). Not needed for CLI-only.
- **Migration from tsup:** If we ever switched from tsup, `npx tsdown-migrate` automates config conversion.
- **Code splitting:** tsdown always enables it; cannot disable. Fine for multiple entry points.

## Notes

- **INTEGRATION.md:** No changes needed; it describes user workflow, not package internals.
- **Pre-push:** `check:code` (with build) runs on pre-push. Build adds a few seconds; acceptable for most projects.
- **tsdown entry structure:** Verify output paths; use explicit `entry` mapping if needed.

## Rollback

If issues arise: revert to tsx-in-dependencies approach (current fix). Simpler, works, less idiomatic. **Before implementing:** Note the current tsx-in-deps commit SHA or branch for quick revert.

---

## References

- [tsdown docs](https://tsdown.dev/)
- [tsdown migrate from tsup](https://tsdown.dev/guide/migrate-from-tsup)
- [tsdown config options](https://tsdown.dev/reference/api/Interface.UserConfig)
- [tsdown --from-vite](https://tsdown.dev/options/config-file)
- [tsup vs tsdown vs unbuild (2026)](https://www.pkgpulse.com/blog/tsup-vs-tsdown-vs-unbuild-typescript-library-bundling-2026)
- [Node.js: Publishing a TypeScript package](https://nodejs.dev/en/learn/typescript/publishing-a-ts-package)
- [privatenumber/tsx](https://github.com/privatenumber/tsx) — package.json
- [mattallty/Caporal.js](https://github.com/mattallty/Caporal.js) — tsup.config.ts, package.json
