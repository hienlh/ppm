/**
 * A dev-linked extension is a symlink under `<extensions>/node_modules`, never a dependency in
 * its `package.json`, so `bun remove` cannot take it away. Removing one used to leave the link
 * behind; once its source folder moved, the next dev-link of the same id hit EEXIST.
 */
import { afterEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { devLinkExtension, removeExtension } from "../../../src/services/extension-installer.ts";
import { getExtensionById } from "../../../src/services/db.service.ts";

const ID = "ppm-devlink-remove-test";
const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "ppm-devlink-"));
  dirs.push(dir);
  return dir;
}

function extensionSource(): string {
  const dir = scratch();
  writeFileSync(resolve(dir, "package.json"), JSON.stringify({
    name: ID, version: "1.0.0", main: "index.js", engines: { ppm: ">=0.1.0" },
  }));
  writeFileSync(resolve(dir, "index.js"), "export function activate() {}\n");
  return dir;
}

function linkExists(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("removing a dev-linked extension", () => {
  it("deletes its link and keeps the source folder", async () => {
    const extensionsDir = scratch();
    const source = extensionSource();
    devLinkExtension(source, extensionsDir);
    const link = resolve(extensionsDir, "node_modules", ID);
    expect(linkExists(link)).toBe(true);

    await removeExtension(ID, extensionsDir);

    expect(linkExists(link)).toBe(false);
    expect(existsSync(resolve(source, "index.js"))).toBe(true);
    expect(getExtensionById(ID)).toBeNull();
  });

  it("dev-links the same id from a new place after the old source folder is gone", async () => {
    const extensionsDir = scratch();
    const first = extensionSource();
    devLinkExtension(first, extensionsDir);
    rmSync(first, { recursive: true, force: true });

    const second = extensionSource();
    devLinkExtension(second, extensionsDir);

    expect(readlinkSync(resolve(extensionsDir, "node_modules", ID))).toBe(second);
  });

  it("never follows an id out of node_modules", async () => {
    const extensionsDir = scratch();
    mkdirSync(resolve(extensionsDir, "node_modules"), { recursive: true });
    const outside = extensionSource();
    const { symlinkSync } = await import("node:fs");
    const decoy = resolve(extensionsDir, "decoy");
    symlinkSync(outside, decoy, "dir");

    await removeExtension("../decoy", extensionsDir);

    expect(linkExists(decoy)).toBe(true);
  });
});
