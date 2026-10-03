/**
 * The key and certificate files a connection names, read on the PPM host. Every refusal here is
 * one a generic file route already makes; a connection must not be the way around it.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir } from "../../../../src/services/ppm-dir.ts";
import { HostFileError, readHostFile } from "../../../../src/services/database/host-files.ts";

const originalPpmHome = process.env.PPM_HOME;
const home = mkdtempSync(join(tmpdir(), "ppm-host-files-home-"));
const outside = mkdtempSync(join(tmpdir(), "ppm-host-files-"));

beforeEach(() => {
  process.env.PPM_HOME = home;
  _resetPpmDir();
});

afterAll(() => {
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function refusal(file: string, what = "CA certificate"): string {
  try {
    readHostFile(file, what);
  } catch (e) {
    expect(e).toBeInstanceOf(HostFileError);
    return (e as Error).message;
  }
  throw new Error(`expected ${file} to be refused`);
}

describe("reading a file", () => {
  it("returns the bytes, read afresh each time", () => {
    const file = join(outside, "ca.pem");
    writeFileSync(file, "one");
    expect(readHostFile(file, "CA certificate").toString()).toBe("one");
    writeFileSync(file, "two");
    expect(readHostFile(`  ${file}  `, "CA certificate").toString()).toBe("two");
  });

  it("says what is wrong, naming the file as it was written", () => {
    expect(refusal(join(outside, "missing.pem"))).toBe(`Cannot read the CA certificate ${join(outside, "missing.pem")}: no such file on the PPM host`);
    expect(refusal(outside, "SSH key file")).toBe(`Cannot read the SSH key file ${outside}: that is a folder`);
    // `~` is the PPM host's home, not a folder called "~".
    expect(refusal("~/ppm-host-files-test-missing.pem")).toBe("Cannot read the CA certificate ~/ppm-host-files-test-missing.pem: no such file on the PPM host");
    expect(homedir()).not.toBe("");
  });

  it("refuses a relative path, which would be read from the server's own working folder", () => {
    expect(refusal("id_ed25519", "SSH key file")).toBe("Give the SSH key file as a full path on the PPM host, not id_ed25519.");
    expect(refusal("./certs/ca.pem")).toBe("Give the CA certificate as a full path on the PPM host, not ./certs/ca.pem.");
  });

  it("refuses the folders holding PPM's own credentials, by name and through a link", () => {
    const inside = join(home, "ppm.db");
    writeFileSync(inside, "secret");
    expect(refusal(inside, "SSH key file")).toContain("PPM does not read the SSH key file from a folder holding its own credentials");
    if (process.platform === "win32") return; // a symlink needs a privilege there
    const link = join(outside, "innocent.pem");
    symlinkSync(inside, link);
    expect(refusal(link)).toContain("a folder holding its own credentials");
    const dirLink = join(outside, "certs");
    symlinkSync(home, dirLink);
    expect(refusal(join(dirLink, "ppm.db"))).toContain("a folder holding its own credentials");
  });

  it("does not open a FIFO or a device, which would hold the server's only thread", () => {
    if (process.platform === "win32") return;
    const fifo = join(outside, "fifo");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    expect(refusal(fifo)).toBe(`Cannot read the CA certificate ${fifo}: that is not a regular file`);
    expect(refusal("/dev/zero")).toBe("Cannot read the CA certificate /dev/zero: that is not a regular file");
  });

  it("refuses a file far too big to be a key or a certificate", () => {
    const big = join(outside, "dump.sql");
    writeFileSync(big, "");
    truncateSync(big, 3 * 1024 * 1024);
    expect(refusal(big)).toBe(`Cannot read the CA certificate ${big}: it is 3.0 MB, far too big for a key or certificate`);
  });

  it("refuses a Windows network share", () => {
    if (process.platform !== "win32") return;
    expect(refusal("\\\\attacker\\share\\ca.pem")).toContain("from a network share");
  });
});

describe("the refusal is not a prefix accident", () => {
  it("reads a folder whose name only starts like the PPM directory's", () => {
    const sibling = `${home}-certs`;
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "ca.pem"), "ok");
    try {
      expect(readHostFile(join(sibling, "ca.pem"), "CA certificate").toString()).toBe("ok");
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});
