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
          statix
          deadnix
          typos
          actionlint
          lychee
          shellcheck
          shfmt
        ];

        # `apps.default`'s script, bound once so both `apps.default.program` and
        # `checks.app-uses-built-package` inspect the identical realized derivation.
        appProgram = pkgs.writeShellScript "run-auto-pr" ''
          cd "${self}" && exec bun run src/workflow/auto-pr-run.ts "$@"
        '';

        # The PATH-prepend line from devShells.default.shellHook, bound once so
        # `checks.dev-shell-path-precedence` exercises the identical string the dev shell
        # actually uses (not a copy that could silently drift from it).
        devShellPathExport = ''export PATH="$PWD/node_modules/.bin:$PATH"'';
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
          # These checks reproduce confirmed defects in default.nix/flake.nix. They are EXPECTED
          # TO FAIL until Tasks 3.2-3.4 fix the launcher, `apps.default`, and the dev shell. Do
          # not "fix" a failure here without checking the task/plan first.

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

          # Defect: apps.default ignores packages.default and instead cds into the flake's own
          # source tree (`${self}`) to run ambient `bun` against uncompiled TS source.
          app-uses-built-package = pkgs.runCommand "app-uses-built-package" { } ''
            if grep -qF "${builtins.toString self}" ${appProgram}; then
              echo "FAIL: apps.default still cds into the flake source tree (self)" >&2
              echo "instead of invoking packages.default's built output. Fixed by Task 3.3." >&2
              exit 1
            fi
            if ! grep -qF "${package}" ${appProgram}; then
              echo "FAIL: apps.default's script does not reference packages.default's store" >&2
              echo "path. Fixed by Task 3.3." >&2
              exit 1
            fi
            touch $out
          '';

          # Defect: `.bun-version` and nixpkgs' `bun` are allowed to drift silently.
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

          # Defect: devShells.default.packages does not provide Node at all yet. Checks the
          # *major version* against .nvmrc (not just presence): once Task 3.4 adds a nodejs
          # package here, it must actually match .nvmrc/the supported LTS, not just be "some node".
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

          # Defect (Task 3.4's PATH-ordering requirement, currently violated): shellHook
          # PREPENDS node_modules/.bin, so an npm-installed binary of the same name as a
          # Nix-provided tool shadows the working Nix version instead of the plan's required
          # "append node_modules/.bin after Nix-provided tools". Reproduced with `bun` itself
          # (already in devShellPackages) as the overlapping name, via a decoy
          # node_modules/.bin/bun, so this check is meaningful today rather than waiting for
          # Task 3.4 to add biome/rumdl to devShellPackages.
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
          '';
        };

        apps.default = {
          type = "app";
          program = toString appProgram;
        };

        formatter = pkgs.nixfmt;
      }
    );
}
