# Standalone Nix package for auto-pr.
# Used by flake.nix when published independently.

{ pkgs }:

let
  packageJson = builtins.fromJSON (builtins.readFile ./package.json);
  src = builtins.path {
    path = ./.;
    name = "auto-pr-src";
    filter = path: type:
      builtins.baseNameOf path != "node_modules"
      && builtins.baseNameOf path != ".git"
      && builtins.baseNameOf path != "result"
      && builtins.baseNameOf path != "coverage";
  };
  npmDepsHash = "sha256-SU2tlBSl2v9oWD5FKWCieNc2AJ/JsgjwyLXrS/3ymwc=";
in
pkgs.buildNpmPackage rec {
  pname = "auto-pr";
  version = packageJson.version;
  inherit src npmDepsHash;
  nodejs = pkgs.nodejs_24;
  npmBuildScript = "build";
  dontCheck = true;
  installPhase = ''
    mkdir -p $out/lib/node_modules/auto-pr
    cp -r package.json package-lock.json node_modules scripts .github $out/lib/node_modules/auto-pr/
    mkdir -p $out/bin
    echo '#!${pkgs.runtimeShell}
    cd "${placeholder "out"}/lib/node_modules/auto-pr" && exec npx tsx scripts/run-auto-pr.sh "$@"' > $out/bin/run-auto-pr
    chmod +x $out/bin/run-auto-pr
  '';
}
