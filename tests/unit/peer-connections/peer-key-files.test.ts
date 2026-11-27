/**
 * The identity and storage key files: created once, reused, never silently replaced when damaged,
 * named per database, and inside the PPM directory every filesystem door already refuses.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import { isPpmDirPath } from "../../../src/services/fs-credential-path-guard.ts";
import { assistantPrivateRoots } from "../../../src/services/assistant/assistant-private-paths.ts";
import { loadPeerIdentity, peerIdentityPath, resetPeerIdentityCache } from "../../../src/services/peer-connections/peer-identity.ts";
import { openStored, peerKeyStorePath, resetPeerKeyStoreCache, sealStored } from "../../../src/services/peer-connections/peer-key-store.ts";
import { PeerKeyFileError } from "../../../src/services/peer-connections/peer-secret-file.ts";
import { leavePeerSides, makePeerSide } from "./two-peer-sides.ts";

const side = makePeerSide("keys");
afterAll(leavePeerSides);

beforeEach(() => side.run(() => {
  rmSync(peerIdentityPath(), { force: true });
  rmSync(peerKeyStorePath(), { force: true });
  resetPeerIdentityCache();
  resetPeerKeyStoreCache();
}));

describe("peer identity file", () => {
  it("is created once, named after the database, and reused", () => side.run(() => {
    const a = loadPeerIdentity();
    expect(basename(peerIdentityPath())).toBe("peer-identity.ppm.json");
    if (process.platform !== "win32") expect(statSync(peerIdentityPath()).mode & 0o777).toBe(0o600);
    resetPeerIdentityCache();
    const b = loadPeerIdentity();
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  }));

  it("throws on a damaged file instead of making a new identity", () => side.run(() => {
    loadPeerIdentity();
    const original = readFileSync(peerIdentityPath(), "utf8");
    for (const damaged of ["{not json", JSON.stringify({ v: 1 }), JSON.stringify({ ...JSON.parse(original), publicKey: Buffer.alloc(32).toString("base64url") })]) {
      writeFileSync(peerIdentityPath(), damaged);
      resetPeerIdentityCache();
      expect(() => loadPeerIdentity()).toThrow(PeerKeyFileError);
      expect(readFileSync(peerIdentityPath(), "utf8")).toBe(damaged);
    }
  }));
});

describe("peer storage key", () => {
  it("seals and opens a value bound to its label", () => side.run(() => {
    const sealed = sealStored("root-key-bytes", "peer_connections.root_key_enc:c1");
    expect(sealed).not.toContain("root-key-bytes");
    expect(openStored(sealed, "peer_connections.root_key_enc:c1").toString()).toBe("root-key-bytes");
    expect(() => openStored(sealed, "peer_connections.root_key_enc:c2")).toThrow();
    expect(basename(peerKeyStorePath())).toBe("peer-keys.ppm.key");
    if (process.platform !== "win32") expect(statSync(peerKeyStorePath()).mode & 0o777).toBe(0o600);
  }));

  it("does not make a new key to read with when the key file is gone or damaged", () => side.run(() => {
    const sealed = sealStored("v", "l");
    rmSync(peerKeyStorePath());
    resetPeerKeyStoreCache();
    expect(() => openStored(sealed, "l")).toThrow(PeerKeyFileError);
    writeFileSync(peerKeyStorePath(), Buffer.alloc(31));
    resetPeerKeyStoreCache();
    expect(() => openStored(sealed, "l")).toThrow(PeerKeyFileError);
    expect(() => sealStored("w", "l")).toThrow(PeerKeyFileError);
    expect(readFileSync(peerKeyStorePath()).length).toBe(31);
  }));
});

describe("where the files live", () => {
  it("is inside the PPM directory, which the file doors and the Assistant both refuse", () => side.run(() => {
    loadPeerIdentity();
    sealStored("v", "l");
    for (const p of [peerIdentityPath(), peerKeyStorePath()]) {
      expect(p.startsWith(getPpmDir())).toBe(true);
      expect(isPpmDirPath(p)).toBe(true);
    }
    expect(assistantPrivateRoots()).toContain(getPpmDir());
  }));
});
