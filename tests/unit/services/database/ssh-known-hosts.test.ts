/**
 * The host keys PPM trusts: recorded the first time, in OpenSSH's own format so `ssh-keygen -lf`
 * reads the file, and a different key for a recorded host reported with the lines to remove.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { _resetPpmDir } from "../../../../src/services/ppm-dir.ts";
import {
  checkHostKey, hostKeyFingerprint, hostKeyType, knownHostName, knownHostsPath,
} from "../../../../src/services/database/ssh-known-hosts.ts";

/** An ed25519 host key; `ssh-keygen -lf` prints the fingerprint below for it. */
const ED25519 = Buffer.from("AAAAC3NzaC1lZDI1NTE5AAAAIEL6MpNtrVoL7uUSko4qvXmZOHcAQjq7vxpsTHI5uYEz", "base64");
const ED25519_FINGERPRINT = "SHA256:b89tbwOx0ysTwDrQ7lM9MAyOVB0GUbx55VBRuvWoOu0";
/** Another key of the same type: the same blob with a different last byte. */
const OTHER = Buffer.concat([ED25519.subarray(0, -1), Buffer.from([ED25519.at(-1)! ^ 1])]);

const originalPpmHome = process.env.PPM_HOME;
const home = mkdtempSync(join(tmpdir(), "ppm-known-hosts-"));

beforeEach(() => {
  process.env.PPM_HOME = home;
  _resetPpmDir();
  rmSync(join(home, "ssh"), { recursive: true, force: true });
});

afterAll(() => {
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  rmSync(home, { recursive: true, force: true });
});

describe("names and fingerprints", () => {
  it("names a host as OpenSSH does: bare on 22, bracketed with any other port", () => {
    expect(knownHostName("Bastion.Example.COM", 22)).toBe("bastion.example.com");
    expect(knownHostName("db", 2222)).toBe("[db]:2222");
    expect(knownHostName("::1", 2222)).toBe("[::1]:2222");
  });

  it("prints the fingerprint ssh-keygen prints, and reads the key type from the blob", () => {
    expect(hostKeyFingerprint(ED25519)).toBe(ED25519_FINGERPRINT);
    expect(hostKeyType(ED25519)).toBe("ssh-ed25519");
    expect(hostKeyType(Buffer.from([0, 0, 0, 200, 1]))).toBeNull();
    expect(hostKeyType(Buffer.from([0, 0, 0, 3, 0x3c, 0x3e, 0x20]))).toBeNull(); // "<> "
  });

  it("lives in the PPM directory, not in ~/.ssh", () => {
    expect(knownHostsPath()).toBe(join(home, "ssh", "known_hosts"));
  });
});

describe("checking a key", () => {
  it("records a new host, then knows it", () => {
    expect(checkHostKey("jump.example.com", 22, ED25519)).toEqual({ status: "added", fingerprint: ED25519_FINGERPRINT });
    expect(readFileSync(knownHostsPath(), "utf8")).toBe(`jump.example.com ssh-ed25519 ${ED25519.toString("base64")}\n`);
    expect(checkHostKey("JUMP.example.com", 22, ED25519)).toEqual({ status: "known", fingerprint: ED25519_FINGERPRINT });
    if (process.platform !== "win32") {
      expect(statSync(knownHostsPath()).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(knownHostsPath())).mode & 0o777).toBe(0o700);
    }
  });

  it("keeps ports apart: the same name on another port is another host", () => {
    checkHostKey("db", 22, ED25519);
    expect(checkHostKey("db", 2222, OTHER).status).toBe("added");
    expect(readFileSync(knownHostsPath(), "utf8").trim().split("\n")).toEqual([
      `db ssh-ed25519 ${ED25519.toString("base64")}`,
      `[db]:2222 ssh-ed25519 ${OTHER.toString("base64")}`,
    ]);
  });

  it("reports a different key with the recorded fingerprint and its line, and writes nothing", () => {
    mkdirSync(dirname(knownHostsPath()), { recursive: true });
    const text = `# written by hand\n\n[db]:2222 ssh-ed25519 ${ED25519.toString("base64")}\n`;
    writeFileSync(knownHostsPath(), text);
    expect(checkHostKey("db", 2222, OTHER)).toEqual({
      status: "changed",
      fingerprint: hostKeyFingerprint(OTHER),
      recorded: [ED25519_FINGERPRINT],
      lines: [3],
    });
    expect(readFileSync(knownHostsPath(), "utf8")).toBe(text);
  });

  it("reads a line naming several hosts, and passes over what only OpenSSH writes", () => {
    mkdirSync(dirname(knownHostsPath()), { recursive: true });
    writeFileSync(knownHostsPath(), [
      `|1|hashedName=|hash= ssh-ed25519 ${OTHER.toString("base64")}`,
      `@cert-authority *.example.com ssh-ed25519 ${OTHER.toString("base64")}`,
      `@revoked db ssh-ed25519 ${OTHER.toString("base64")}`,
      `other,db,10.0.0.5 ssh-ed25519 ${ED25519.toString("base64")} comment`,
      "",
    ].join("\n"));
    expect(checkHostKey("10.0.0.5", 22, ED25519).status).toBe("known");
    expect(checkHostKey("db", 22, ED25519).status).toBe("known");
  });

  it("knows a host that has two keys recorded when it shows either", () => {
    mkdirSync(dirname(knownHostsPath()), { recursive: true });
    writeFileSync(knownHostsPath(), `db ssh-ed25519 ${ED25519.toString("base64")}\ndb ssh-ed25519 ${OTHER.toString("base64")}\n`);
    expect(checkHostKey("db", 22, OTHER).status).toBe("known");
  });
});
