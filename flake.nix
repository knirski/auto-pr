{
  description = "Auto-PR: create PRs from conventional commits on ai/* branches";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in
    {
      packages.${system} = {
        default = pkgs.callPackage ./default.nix { };
        update-npm-deps-hash = pkgs.writeShellApplication {
          name = "update-npm-deps-hash";
          runtimeInputs = with pkgs; [ prefetch-npm-deps gnused ];
          text = ''
            hash=$(prefetch-npm-deps package-lock.json)
            echo "Updated npm dependency hash: $hash" >&2
            sed -i "s|npmDepsHash = \"sha256-[^\"]*\"|npmDepsHash = \"$hash\"|" default.nix
          '';
        };
      };

      devShells.${system}.default = pkgs.mkShell {
        buildInputs = [
          pkgs.nodejs_24
          pkgs.nodePackages.npm
        ];
        shellHook = ''
          export PATH="$PWD/node_modules/.bin:$PATH"
          [ -d node_modules ] || npm install
        '';
      };

      apps.${system} = {
        default = {
          type = "app";
          program = toString (pkgs.writeShellScript "run-auto-pr" ''
            cd "${self}" && exec ./scripts/run-auto-pr.sh "$@"
          '');
        };
      };

      formatter.${system} = pkgs.nixfmt;
    };
}
