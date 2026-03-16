{
  description = "Auto-PR: create PRs from conventional commits on ai/* branches";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.11";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-linux" ] (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        checks = {
          default = pkgs.callPackage ./default.nix { };
          nix-lint = pkgs.runCommand "nix-lint" { } ''
            cp -r ${self} /tmp/check-src
            cd /tmp/check-src
            ${pkgs.statix}/bin/statix check .
            ${pkgs.deadnix}/bin/deadnix .
            touch $out
          '';
        };

        packages = {
          default = pkgs.callPackage ./default.nix { };
          inherit (pkgs) statix deadnix typos actionlint lychee shellcheck shfmt prefetch-npm-deps;
          update-npm-deps-hash = pkgs.writeShellApplication {
            name = "update-npm-deps-hash";
            runtimeInputs = with pkgs; [
              prefetch-npm-deps
              gnused
            ];
            text = ''
              hash=$(prefetch-npm-deps package-lock.json)
              echo "Updated npm dependency hash: $hash" >&2
              sed -i "s|npmDepsHash = \"sha256-[^\"]*\"|npmDepsHash = \"$hash\"|" default.nix
            '';
          };
        };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs_24
            nodePackages.npm
            statix
            deadnix
            typos
            actionlint
            lychee
            shellcheck
            shfmt
            prefetch-npm-deps
          ];
          shellHook = ''
            export PATH="$PWD/node_modules/.bin:$PATH"
            [ -d node_modules ] || npm install
          '';
        };

        apps.default = {
          type = "app";
          program = toString (
            pkgs.writeShellScript "run-auto-pr" ''
              cd "${self}" && exec npx tsx src/workflow/run-auto-pr.ts "$@"
            ''
          );
        };

        formatter = pkgs.nixfmt;
      }
    );
}
