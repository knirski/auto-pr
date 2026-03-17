# Standalone Nix package for auto-pr.
# Used by flake.nix when published independently.
# Uses bun2nix for dependency fetching.

{ pkgs, bun2nix }:

let
  packageJson = builtins.fromJSON (builtins.readFile ./package.json);
  src = builtins.path {
    path = ./.;
    name = "auto-pr-src";
    filter = path: _:
      builtins.baseNameOf path != "node_modules"
      && builtins.baseNameOf path != ".git"
      && builtins.baseNameOf path != "result"
      && builtins.baseNameOf path != "coverage";
  };
in
pkgs.stdenv.mkDerivation rec {
  pname = "auto-pr";
  inherit (packageJson) version;
  inherit src;

  nativeBuildInputs = [ bun2nix.hook pkgs.bun ];
  bunDeps = bun2nix.fetchBunDeps { bunNix = ./bun.nix; };

  dontUseBunBuild = true;

  buildPhase = "bun run build";

  installPhase = ''
    mkdir -p $out/lib/node_modules/auto-pr
    cp -r package.json bun.lock node_modules dist .github .nvmrc $out/lib/node_modules/auto-pr/
    mkdir -p $out/bin
    echo '#!${pkgs.runtimeShell}
    cd "$out/lib/node_modules/auto-pr" && exec node dist/workflow/auto-pr-run.js "$@"' > $out/bin/run-auto-pr
    chmod +x $out/bin/run-auto-pr
  '';
}
