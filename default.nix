# Standalone Nix package for auto-pr.
# Used by flake.nix when published independently.
# Uses bun2nix for dependency fetching.

{ pkgs, bun2nix }:

let
  packageJson = builtins.fromJSON (builtins.readFile ./package.json);
  src = pkgs.lib.cleanSourceWith {
    src = ./.;
    name = "auto-pr-src";
    filter =
      path: _:
      let
        baseName = builtins.baseNameOf path;
      in
      !builtins.elem baseName [
        "node_modules"
        ".git"
        "result"
        "coverage"
        ".worktrees"
        "test"
        "docs"
      ];
  };
in
pkgs.stdenv.mkDerivation rec {
  pname = "auto-pr";
  inherit (packageJson) version;
  inherit src;
  strictDeps = true;

  nativeBuildInputs = [
    bun2nix.hook
    pkgs.bun
    pkgs.makeWrapper
  ];
  bunDeps = bun2nix.fetchBunDeps { bunNix = ./bun.nix; };

  dontUseBunBuild = true;

  buildPhase = "bun run build";

  installPhase = ''
    mkdir -p $out/lib/node_modules/auto-pr
    cp -r package.json bun.lock dist .github .nvmrc $out/lib/node_modules/auto-pr/
    makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/run-auto-pr \
      --add-flags "$out/lib/node_modules/auto-pr/dist/workflow/auto-pr-run.js"
  '';
}
