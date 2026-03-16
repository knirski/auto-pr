# Standalone Nix package for auto-pr.
# Used by flake.nix when published independently.

{ pkgs }:

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
  npmDepsHash = "sha256-XnFAoP1KUtNDDVytikA9mYMLzDWylOz0NuaoBOISnQk=";
in
pkgs.buildNpmPackage rec {
  pname = "auto-pr";
  inherit (packageJson) version;
  inherit src npmDepsHash;
  nodejs = pkgs.nodejs_24;
  npmBuildScript = "build";
  dontCheck = true;
  installPhase = ''
    mkdir -p $out/lib/node_modules/auto-pr
    cp -r package.json package-lock.json node_modules dist .github .nvmrc $out/lib/node_modules/auto-pr/
    mkdir -p $out/bin
    echo '#!${pkgs.runtimeShell}
    cd "${placeholder "out"}/lib/node_modules/auto-pr" && exec node dist/workflow/auto-pr-run.mjs "$@"' > $out/bin/run-auto-pr
    chmod +x $out/bin/run-auto-pr
  '';
}
