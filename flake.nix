{
  description = "Restate TypeScript SDK — development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";

    # Only needed by the `wasm` shell, to get the pinned Rust toolchain
    # (see sdk-shared-core-wasm-bindings/rust-toolchain.toml).
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      rust-overlay,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ rust-overlay.overlays.default ];
        };

        # Tools every contributor needs. The committed WASM bindings mean
        # Node + pnpm is enough for build / test / lint / verify.
        commonTools = [
          pkgs.nodejs_24
          pkgs.pnpm
          pkgs.git
        ];

        # Pinned Rust toolchain matching rust-toolchain.toml, plus the wasm
        # target. Only used to rebuild the shared-core WASM (`pnpm build:core`).
        rustToolchain = pkgs.rust-bin.stable."1.92.0".minimal.override {
          targets = [ "wasm32-unknown-unknown" ];
          extensions = [
            "rustfmt"
            "clippy"
          ];
        };
      in
      {
        devShells = {
          # `nix develop` — the everyday shell.
          default = pkgs.mkShell {
            name = "restate-sdk-typescript";
            packages = commonTools;
            shellHook = ''
              echo "restate sdk-typescript dev shell"
              echo "  node $(node --version)  |  pnpm $(pnpm --version)"
              echo "  run 'pnpm install' to get started"
            '';
          };

          # `nix develop .#wasm` — for rebuilding the shared-core WASM bindings.
          wasm = pkgs.mkShell {
            name = "restate-sdk-typescript-wasm";
            packages = commonTools ++ [
              rustToolchain
              pkgs.wasm-pack
              pkgs.wasm-bindgen-cli
              pkgs.binaryen # provides wasm-opt
            ];
            shellHook = ''
              echo "restate sdk-typescript WASM build shell"
              echo "  node $(node --version)  |  pnpm $(pnpm --version)  |  $(rustc --version)"
              echo "  rebuild with 'pnpm build:core'"
            '';
          };
        };
      }
    );
}
