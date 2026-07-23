/**
 * Packed-CLI fixture for auto-pr-init (Task 1.4).
 *
 * Proves `auto-pr-init` installs BOTH entry workflows when run the way a real adopter runs it: as a
 * packaged module extracted from the published tarball, NOT from this repo's own source tree /
 * monorepo layout. This exercises the `pkgRoot` derivation in runInit (`import.meta.url` →
 * dirname/../.. ), which is only meaningfully tested from a genuinely packed/installed location.
 *
 * Placement: `test/integration/` so it is EXCLUDED from the default `bun test` fast suite
 * (bunfig.toml `pathIgnorePatterns`) and its coverage gate. It builds + packs + extracts, which is
 * slow and touches the git-tracked `dist/`. Run it with:
 *   bun --config=bunfig.integration.toml test test/integration/auto-pr-init-pack.integration.test.ts
 * (or via `bun run test:integration`). It needs none of the INTEGRATION_* env pins.
 *
 * NOTE: building rewrites the git-tracked `dist/`. Callers must `git checkout -- dist/` afterward.
 * This sandbox has no node/npm, so the packed CLI is invoked with `bun` (import.meta.url resolution
 * is identical to node for this path).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const tmpRoots: string[] = [];

function freshTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

function run(cmd: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

afterAll(() => {
  for (const dir of tmpRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("auto-pr-init packed CLI", () => {
  test("installs both entry workflows from a packed+extracted tarball", () => {
    // 1. Build dist/ from current source so the tarball reflects this branch's code.
    const build = run(["bun", "run", "build"], repoRoot);
    expect(build.code).toBe(0);

    // 2. Pack exactly as publishing would (respects package.json `files`). --ignore-scripts so we
    //    do not rebuild redundantly (step 1 already built dist/). `bun pm pack` rejects
    //    --filename together with --destination, so use --destination and glob the .tgz.
    const packDir = freshTmp("auto-pr-pack-");
    const pack = run(["bun", "pm", "pack", "--ignore-scripts", "--destination", packDir], repoRoot);
    expect(pack.code).toBe(0);
    const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
    expect(tgz).toBeDefined();
    const tarball = join(packDir, tgz ?? "");
    expect(existsSync(tarball)).toBe(true);

    // 3. Extract into a fresh dir — simulates node_modules/auto-pr (top-level `package/`).
    const extractDir = freshTmp("auto-pr-extract-");
    const untar = run(["tar", "-xzf", tarball, "-C", extractDir], extractDir);
    expect(untar.code).toBe(0);
    const pkgRoot = join(extractDir, "package");
    const initEntry = join(pkgRoot, "dist", "tools", "auto-pr-init.js");
    expect(existsSync(initEntry)).toBe(true);

    // 4. Run the packed entry point against a fresh working directory (adopter repo).
    const workDir = freshTmp("auto-pr-work-");
    const cli = run(["bun", initEntry], workDir);
    expect(cli.code).toBe(0);

    // 5. Both halves of the two-workflow architecture must land.
    expect(existsSync(join(workDir, ".github", "workflows", "auto-pr.yml"))).toBe(true);
    expect(existsSync(join(workDir, ".github", "workflows", "auto-pr-create.yml"))).toBe(true);
    // Sanity: other scaffolded files too.
    expect(existsSync(join(workDir, ".github", "PULL_REQUEST_TEMPLATE.md"))).toBe(true);
    expect(existsSync(join(workDir, ".nvmrc"))).toBe(true);
  }, 120_000);
});
