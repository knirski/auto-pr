{
  description = "Auto-PR: create PRs from conventional commits on ai/** branches";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    bun2nix.url = "github:nix-community/bun2nix?tag=2.0.8";
    bun2nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, flake-utils, bun2nix }:
    flake-utils.lib.eachSystem [
      "x86_64-linux"
      "aarch64-linux"
      "aarch64-darwin"
    ] (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Bound once and reused by `checks.default`, `packages.default`, and the Task 3.1 RED
        # checks below, so the checks build/inspect the exact same derivation the package exposes.
        package = pkgs.callPackage ./default.nix { inherit (bun2nix.packages.${system}) bun2nix; };

        # `packages.default`'s full runtime closure, used to assert (or, for now, refute) that it
        # references a Nix-provided Node interpreter. See `checks.launcher-references-node`.
        packageClosure = pkgs.closureInfo { rootPaths = [ package ]; };

        # Mirrors `devShells.default.packages` (see below) so RED checks can assert what a tool
        # invoked via `nix develop -c <tool>` would actually resolve to, without recursively
        # invoking `nix develop` from inside a sandboxed check build (which Nix does not support:
        # check derivations build in an isolated sandbox with no access to the Nix daemon/CLI).
        devShellPackages = with pkgs; [
          act
          bun
          nodejs_24
          biome
          rumdl
          statix
          deadnix
          typos
          actionlint
          lychee
          shellcheck
          shfmt
        ];

        # The PATH-append line from devShells.default.shellHook, bound once so
        # `checks.dev-shell-path-precedence` exercises the identical string the dev shell
        # actually uses (not a copy that could silently drift from it). Appended (not
        # prepended) so Nix-provided tools (bun, biome, rumdl, ...) resolve before any
        # same-named binary an npm/bun install placed in node_modules/.bin.
        devShellPathExport = ''export PATH="$PATH:$PWD/node_modules/.bin"'';
      in
      {
        checks = {
          default = package;
          nix-lint = pkgs.runCommand "nix-lint" { } ''
            cp -r ${self} /tmp/check-src
            cd /tmp/check-src
            ${pkgs.statix}/bin/statix check .
            ${pkgs.deadnix}/bin/deadnix --exclude bun.nix .
            touch $out
          '';

          # ─── Task 3.1 (RED phase, Workstream 3) ──────────────────────────────────────────────
          # These checks reproduced confirmed defects in default.nix/flake.nix. Tasks 3.2-3.4
          # (launcher, `apps.default`, dev shell) have since fixed every defect below; the checks
          # remain as regression guards. Do not "fix" a failure here without checking the
          # task/plan first.

          # Defect: default.nix's installPhase builds bin/run-auto-pr via a single-quoted `echo`,
          # so `$out` inside it is never shell-expanded and survives into the installed script
          # as a literal, unresolved `$out`.
          launcher-no-unresolved-out = pkgs.runCommand "launcher-no-unresolved-out" { } ''
            if grep -F '$out' ${package}/bin/run-auto-pr; then
              echo "FAIL: bin/run-auto-pr contains a literal, unresolved \$out (see above)." >&2
              echo "default.nix's installPhase single-quotes the echo body around \$out, so it" >&2
              echo "is never expanded at build time. Fixed by Task 3.2." >&2
              exit 1
            fi
            touch $out
          '';

          # Defect: the launcher calls ambient `exec node ...`; nothing in the derivation ties it
          # to a Nix-provided Node, so the package's runtime closure has no nodejs store path.
          launcher-references-node = pkgs.runCommand "launcher-references-node" { } ''
            if grep -Eq -- '-nodejs-[0-9]' ${packageClosure}/store-paths; then
              touch $out
            else
              echo "FAIL: run-auto-pr's runtime closure has no nodejs store path." >&2
              echo "default.nix never references a Nix-provided Node interpreter, so nothing" >&2
              echo "pins the launcher's \`exec node\` to the Nix store. Fixed by Task 3.2." >&2
              exit 1
            fi
          '';

          # Defect: combining the two above, the installed package cannot even start.
          launcher-help-smoke = pkgs.runCommand "launcher-help-smoke" { } ''
            set +e
            ${package}/bin/run-auto-pr --help >out.log 2>err.log
            status=$?
            set -e
            if [ "$status" -ne 0 ] || ! grep -q "DEFAULT_BRANCH" out.log; then
              echo "FAIL: run-auto-pr --help did not exit 0 with the expected usage text" >&2
              echo "(exit status: $status). Fixed by Task 3.2 (see also Task 3.1's added" >&2
              echo "--help flag in src/workflow/auto-pr-run.ts)." >&2
              echo "--- stdout ---" >&2
              cat out.log >&2
              echo "--- stderr ---" >&2
              cat err.log >&2
              exit 1
            fi
            touch $out
          '';

          # Fixed by Task 3.3: apps.default.program is now a plain path string pointing at
          # packages.default's installed binary (see below), so there's no separate wrapper
          # script left to grep. Assert the exact string instead of a substring/grep match, so a
          # subtly-wrong value (e.g. pointing at a different binary that also happens to mention
          # `package`'s store path) can't slip through - see the equivalent hardening called out
          # in Workstream 2's review.
          app-uses-built-package = pkgs.runCommand "app-uses-built-package" { } ''
            actual=${pkgs.lib.escapeShellArg self.apps.${system}.default.program}
            expected=${pkgs.lib.escapeShellArg "${package}/bin/run-auto-pr"}
            if [ "$actual" != "$expected" ]; then
              echo "FAIL: apps.default.program is \"$actual\"," >&2
              echo "expected exactly \"$expected\" (packages.default's installed binary)." >&2
              echo "apps.default must invoke packages.default's built output, not the flake" >&2
              echo "source tree. Fixed by Task 3.3." >&2
              exit 1
            fi
            touch $out
          '';

          # `.bun-version` and nixpkgs' `bun` must not drift silently. Fixed by Task 3.4, which
          # aligned `.bun-version`/`packageManager` down to this flake's locked nixpkgs `bun`
          # (1.3.13) rather than bumping the nixpkgs input — see task-3.4-report.md for the
          # reasoning. Kept as a regression guard.
          dev-shell-bun-version = pkgs.runCommand "dev-shell-bun-version" {
            nativeBuildInputs = devShellPackages;
          } ''
            actual="$(bun --version)"
            expected="$(cat ${./.bun-version})"
            if [ "$actual" != "$expected" ]; then
              echo "FAIL: a tool on PATH in devShells.default reports bun $actual, but" >&2
              echo ".bun-version says $expected. Fixed by Task 3.4." >&2
              exit 1
            fi
            touch $out
          '';

          # Checks the *major version* against .nvmrc (not just presence): `devShellPackages`
          # must provide a nodejs matching .nvmrc/the supported LTS, not just "some node". Fixed
          # by Task 3.4, which added `pkgs.nodejs_24` here and bumped `.nvmrc`/`engines.node` to
          # 24 (Node 20 reached EOL in 2026). Kept as a regression guard.
          dev-shell-node-version = pkgs.runCommand "dev-shell-node-version" {
            nativeBuildInputs = devShellPackages;
          } ''
            if ! command -v node >/dev/null 2>&1; then
              echo "FAIL: no \`node\` on PATH from devShells.default.packages. Fixed by Task 3.4." >&2
              exit 1
            fi
            actual_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
            expected_major="$(tr -d '[:space:]' < ${./.nvmrc} | sed -E 's/^v?([0-9]+).*/\1/')"
            if [ "$actual_major" != "$expected_major" ]; then
              echo "FAIL: node on PATH is major version $actual_major, but .nvmrc says" >&2
              echo "$expected_major. Fixed by Task 3.4 (which also aligns .nvmrc/engines.node" >&2
              echo "with the supported LTS)." >&2
              exit 1
            fi
            touch $out
          '';

          # PATH-ordering requirement: shellHook must APPEND node_modules/.bin (not prepend it),
          # so an npm-installed binary of the same name as a Nix-provided tool never shadows the
          # working Nix version. Reproduced with `bun` itself (already in devShellPackages) as the
          # overlapping name, via a decoy node_modules/.bin/bun. Fixed by Task 3.4, which changed
          # `devShellPathExport` from prepend to append. Kept as a regression guard.
          dev-shell-path-precedence = pkgs.runCommand "dev-shell-path-precedence" {
            nativeBuildInputs = devShellPackages;
          } ''
            mkdir -p node_modules/.bin
            cat > node_modules/.bin/bun <<'DECOY'
            #!/bin/sh
            echo DECOY
            DECOY
            chmod +x node_modules/.bin/bun

            ${devShellPathExport}
            resolved="$(command -v bun)"
            if [ "$resolved" = "$PWD/node_modules/.bin/bun" ]; then
              echo "FAIL: devShells.default's shellHook prepends node_modules/.bin, so a" >&2
              echo "same-named npm-installed binary shadows the Nix-provided tool instead of" >&2
              echo "the reverse. Fixed by Task 3.4." >&2
              exit 1
            fi
            touch $out
          '';
        };

        packages = {
          default = package;
          inherit (pkgs) act statix deadnix typos actionlint lychee shellcheck shfmt;
          bun2nix = bun2nix.packages.${system}.default;
          update-bun-nix = pkgs.writeShellApplication {
            name = "update-bun-nix";
            runtimeInputs = [ pkgs.bun bun2nix.packages.${system}.default ];
            text = ''
              bun install
              bun2nix -o bun.nix
              echo "Regenerated bun.nix" >&2
            '';
          };
        };

        devShells.default = pkgs.mkShell {
          packages = devShellPackages;
          shellHook = ''
            ${devShellPathExport}
            [ -d node_modules ] || bun install

            # `bun run <script>`/`bun x <tool>` always prepend node_modules/.bin ahead of the
            # rest of PATH (like npm/yarn), so devShellPathExport's append-only ordering above
            # cannot make those invocations prefer a Nix-provided tool over a same-named
            # project devDependency - PATH precedence alone only affects tools resolved directly
            # from an interactive shell. `@biomejs/biome`/`rumdl` ship prebuilt, dynamically
            # linked native binaries that `bun install` places under node_modules/.bin; those
            # binaries fail to start on NixOS (missing generic-Linux dynamic linker paths - see
            # https://nix.dev/permalink/stub-ld), which is exactly what `bun run lint`/
            # `bun run check:docs` invoke. Re-point node_modules/.bin/{biome,rumdl} at this
            # flake's Nix-built binaries every time the dev shell starts, so those scripts work
            # on NixOS without a manual `nix run nixpkgs#biome`/`nix run nixpkgs#rumdl` fallback.
            # Harmless outside NixOS/outside this shell: node_modules is gitignored, bun
            # regenerates it on install, and the symlink targets remain valid Nix store paths as
            # long as the host has Nix (true for anyone who ran `nix develop` to get here).
            mkdir -p node_modules/.bin
            ln -sf ${pkgs.biome}/bin/biome node_modules/.bin/biome
            ln -sf ${pkgs.rumdl}/bin/rumdl node_modules/.bin/rumdl
          '';
        };

        apps.default = {
          type = "app";
          program = "${package}/bin/run-auto-pr";
        };

        formatter = pkgs.nixfmt;
      }
    );
}
