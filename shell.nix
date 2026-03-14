# Development shell. Prefer: nix develop (flake)
# Fallback for nix-shell without flakes.
{ pkgs ? import <nixpkgs> { } }:

pkgs.mkShell {
  buildInputs = [
    pkgs.nodejs_24
    pkgs.nodePackages.npm
  ];
  shellHook = ''
    export PATH="$PWD/node_modules/.bin:$PATH"
    [ -d node_modules ] || npm install
  '';
}
