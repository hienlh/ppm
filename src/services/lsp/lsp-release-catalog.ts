/**
 * The release builds the Install button downloads, for servers that ship one self-contained
 * binary and no npm package: clangd and lua-language-server. Before these, both meant a system
 * package manager — a password and a choice PPM has no business making — so they had a command to
 * copy and no button.
 *
 * Pure data, keyed `<platform>-<arch>` in Node's own vocabulary so a caller passes
 * `process.platform` and `process.arch` straight through. Every entry is pinned by version AND by
 * SHA-256 (each matches the `digest` GitHub lists for the asset), because this puts an executable
 * on the user's machine. A host with no row has no Install button rather than a binary for some
 * other architecture that fails at spawn with nothing saying why.
 */
import type { ReleaseAsset } from "./server-registry.ts";

export const CLANGD_VERSION = "23.1.0";
const CLANGD_BASE = `https://github.com/clangd/clangd/releases/download/${CLANGD_VERSION}`;
const CLANGD_DIR = `clangd_${CLANGD_VERSION}`;

/**
 * The archive is the binary plus `lib/clang/<n>/include`, the compiler's own headers, which
 * clangd finds relative to itself — so the whole folder is kept, not just `bin/clangd`. Linux is
 * x86-64 only upstream; the macOS build is universal (x86_64 + arm64, read from its Mach-O
 * header), so both Mac rows are one file.
 */
export const CLANGD_ASSETS: Record<string, ReleaseAsset> = {
  "linux-x64": {
    url: `${CLANGD_BASE}/clangd-linux-${CLANGD_VERSION}.zip`,
    sha256: "e53b1a96196095faedb7642cf64964f7fb9ad4a0c1f00dd2c172a3d9dcbafdfd",
    archive: "zip",
    binary: `${CLANGD_DIR}/bin/clangd`,
  },
  "darwin-x64": {
    url: `${CLANGD_BASE}/clangd-mac-${CLANGD_VERSION}.zip`,
    sha256: "1082e6638223b785ca2daf0939f13afcd0bb95c84ee9a4bbaff4745365159253",
    archive: "zip",
    binary: `${CLANGD_DIR}/bin/clangd`,
  },
  "darwin-arm64": {
    url: `${CLANGD_BASE}/clangd-mac-${CLANGD_VERSION}.zip`,
    sha256: "1082e6638223b785ca2daf0939f13afcd0bb95c84ee9a4bbaff4745365159253",
    archive: "zip",
    binary: `${CLANGD_DIR}/bin/clangd`,
  },
  "win32-x64": {
    url: `${CLANGD_BASE}/clangd-windows-${CLANGD_VERSION}.zip`,
    sha256: "23412a240756a162e7b98a282f36aa2a23a88db5ce16a0cbc4fef7253768c810",
    archive: "zip",
    binary: `${CLANGD_DIR}/bin/clangd.exe`,
  },
};

export const LUA_LS_VERSION = "3.19.1";
const LUA_LS_BASE = `https://github.com/LuaLS/lua-language-server/releases/download/${LUA_LS_VERSION}`;

/** The archive has no top folder; the binary loads `main.lua` and `script/` from beside `bin/`. */
export const LUA_LS_ASSETS: Record<string, ReleaseAsset> = {
  "linux-x64": {
    url: `${LUA_LS_BASE}/lua-language-server-${LUA_LS_VERSION}-linux-x64.tar.gz`,
    sha256: "e9235d2d72ef55bc41cf8c99cda2ed64777682024b4bb81f5dea425060c5cbb8",
    archive: "tar.gz",
    binary: "bin/lua-language-server",
  },
  "linux-arm64": {
    url: `${LUA_LS_BASE}/lua-language-server-${LUA_LS_VERSION}-linux-arm64.tar.gz`,
    sha256: "abd2572e8fc929dc838a81ffb8473c5bce0bf39bfe8edb4b120b3b623176ce83",
    archive: "tar.gz",
    binary: "bin/lua-language-server",
  },
  "darwin-x64": {
    url: `${LUA_LS_BASE}/lua-language-server-${LUA_LS_VERSION}-darwin-x64.tar.gz`,
    sha256: "eb373c159cbe556711d7cd316315de2dce969bfd54b31edb7eb9cab2937f2cca",
    archive: "tar.gz",
    binary: "bin/lua-language-server",
  },
  "darwin-arm64": {
    url: `${LUA_LS_BASE}/lua-language-server-${LUA_LS_VERSION}-darwin-arm64.tar.gz`,
    sha256: "0bc077f4447f076b4c92c14e9fd303f5b569eda2ec74b4dca2b55f75fae2e90c",
    archive: "tar.gz",
    binary: "bin/lua-language-server",
  },
  "win32-x64": {
    url: `${LUA_LS_BASE}/lua-language-server-${LUA_LS_VERSION}-win32-x64.zip`,
    sha256: "fdb9a59108cf62517813c97fa5549b0e16d1ef0688306bac728b08434db7e4cd",
    archive: "zip",
    binary: "bin/lua-language-server.exe",
  },
};
