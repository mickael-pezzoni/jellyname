{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  name = "jellyname";

  packages = [
    pkgs.bun
  ];
}
