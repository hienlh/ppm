import { beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getDb, getSessionProjectPath, getStoredPermissionModeAnyAlias, setSessionMetadata, setSessionMigratedTo,
  setSessionPermissionMode,
} from "../../../src/services/db.service.ts";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import {
  childrenOf, countSpawned, depthOf, isSpawned, linkedSessions, parentOf, recordSpawn,
} from "../../../src/services/session-collab/session-links.service.ts";
import { pairCounter } from "../../../src/services/session-collab/pair-counter.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sidecar = () => join(getPpmDir(), "session-collab", "pairs.json");

beforeEach(() => {
  getDb().exec("DELETE FROM session_metadata");
  pairCounter.reloadForTests();
  rmSync(join(getPpmDir(), "session-collab"), { recursive: true, force: true });
});

describe("session links", () => {
  it("records spawns with their depth, parent and children", () => {
    expect(recordSpawn(id(2), id(1))).toBe(1);
    expect(recordSpawn(id(3), id(2))).toBe(2);
    expect(recordSpawn(id(4), id(1))).toBe(1);
    expect(depthOf(id(1))).toBe(0);
    expect(depthOf(id(3))).toBe(2);
    expect(parentOf(id(3))).toBe(id(2));
    expect(parentOf(id(1))).toBeNull();
    expect(childrenOf(id(1)).sort()).toEqual([id(2), id(4)]);
    expect(isSpawned(id(4))).toBe(true);
    expect(countSpawned([id(1), id(3), id(4)])).toBe(2);
  });

  it("refuses a session creating itself or one of its ancestors", () => {
    recordSpawn(id(2), id(1));
    expect(() => recordSpawn(id(1), id(1))).toThrow();
    expect(() => recordSpawn(id(1), id(2))).toThrow();
  });

  it("follows a Codex rename on both sides of a link", () => {
    recordSpawn(id(2), id(1));
    recordSpawn(id(3), id(2));
    // The parent is renamed: its children are still found, under its new id.
    setSessionMigratedTo(id(1), id(11));
    expect(childrenOf(id(11))).toEqual([id(2)]);
    expect(parentOf(id(2))).toBe(id(11));
    // The child is renamed: its link and depth move with it, and it is listed once.
    setSessionMigratedTo(id(2), id(12));
    expect(parentOf(id(12))).toBe(id(11));
    expect(depthOf(id(12))).toBe(1);
    expect(childrenOf(id(11))).toEqual([id(12)]);
    expect(parentOf(id(3))).toBe(id(12));
  });

  it("carries the project with a rename, and finds a stored permission mode under any id the session had", () => {
    setSessionMetadata(id(1), "proj", "/work/proj");
    setSessionPermissionMode(id(1), "plan");
    setSessionMigratedTo(id(1), id(11));
    expect(getSessionProjectPath(id(11))).toBe("/work/proj");
    expect(getStoredPermissionModeAnyAlias(id(11))).toBe("plan");
    // A mode written under the old id after the rename is still the session's.
    setSessionMigratedTo(id(2), id(12));
    setSessionPermissionMode(id(2), "default");
    expect(getStoredPermissionModeAnyAlias(id(12))).toBe("default");
    expect(getStoredPermissionModeAnyAlias(id(3))).toBeNull();
  });

  it("lists every linked session once, with each relation", () => {
    recordSpawn(id(2), id(1));
    recordSpawn(id(3), id(1));
    pairCounter.record(id(1), id(2));
    pairCounter.record(id(1), id(5));
    const links = linkedSessions(id(1)).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    expect(links).toEqual([
      { sessionId: id(2), relations: ["child", "messaged"] },
      { sessionId: id(3), relations: ["child"] },
      { sessionId: id(5), relations: ["messaged"] },
    ]);
    expect(linkedSessions(id(2))).toEqual([{ sessionId: id(1), relations: ["parent", "messaged"] }]);
  });
});

describe("pair counter", () => {
  it("counts an unordered pair, honours grants, and resets on a person's message in either session", () => {
    expect(pairCounter.record(id(1), id(2))).toBe(1);
    expect(pairCounter.record(id(2), id(1))).toBe(2);
    expect(pairCounter.remaining(id(1), id(2), 2)).toBe(0);
    pairCounter.grant(id(2), id(1), 20);
    expect(pairCounter.remaining(id(1), id(2), 2)).toBe(20);
    pairCounter.resetForSession(id(2));
    expect(pairCounter.count(id(1), id(2))).toBe(0);
    expect(pairCounter.remaining(id(1), id(2), 2)).toBe(2);
    // Still linked after the reset.
    expect(pairCounter.messagedWith(id(1))).toEqual([id(2)]);
    expect(pairCounter.record(id(1), id(1))).toBe(0);
  });

  it("keeps per-session allowances", () => {
    pairCounter.setAllowCreate(id(1));
    pairCounter.setAllowEscalation(id(1), id(2), "acceptEdits");
    expect(pairCounter.canCreateWithoutAsking(id(1))).toBe(true);
    expect(pairCounter.canCreateWithoutAsking(id(2))).toBe(false);
    expect(pairCounter.escalationAllowed(id(1), id(2), "acceptEdits")).toBe(true);
    expect(pairCounter.escalationAllowed(id(1), id(2), "default")).toBe(true);
    expect(pairCounter.escalationAllowed(id(2), id(1), "acceptEdits")).toBe(false);
  });

  it("ends an escalation allowance once the target gains more rights than it had when allowed", () => {
    pairCounter.setAllowEscalation(id(1), id(2), "acceptEdits");
    expect(pairCounter.escalationAllowed(id(1), id(2), "bypassPermissions")).toBe(false);
    // Over for good: going back to the mode it had does not bring it back.
    expect(pairCounter.escalationAllowed(id(1), id(2), "acceptEdits")).toBe(false);
  });

  it("takes back a counted message that was never delivered", () => {
    pairCounter.record(id(1), id(2));
    pairCounter.record(id(1), id(2));
    pairCounter.unrecord(id(2), id(1));
    expect(pairCounter.count(id(1), id(2))).toBe(1);
    pairCounter.unrecord(id(1), id(2));
    pairCounter.unrecord(id(1), id(2));
    expect(pairCounter.count(id(1), id(2))).toBe(0);
  });

  it("round-trips through the sidecar and follows renamed sessions; escalation allowances end at a restart", () => {
    pairCounter.record(id(1), id(2));
    pairCounter.grant(id(1), id(2), 5);
    pairCounter.setAllowCreate(id(1));
    pairCounter.setAllowEscalation(id(1), id(2), "bypassPermissions");
    pairCounter.flush();
    expect(existsSync(sidecar())).toBe(true);
    const written = JSON.parse(readFileSync(sidecar(), "utf8"));
    expect(written.version).toBe(1);
    expect(written.allowEscalation).toBeUndefined();

    // Renamed while the file sat on disk: read back under the new id.
    setSessionMigratedTo(id(1), id(11));
    pairCounter.reloadForTests();
    expect(pairCounter.count(id(11), id(2))).toBe(1);
    expect(pairCounter.remaining(id(11), id(2), 1)).toBe(5);
    expect(pairCounter.canCreateWithoutAsking(id(11))).toBe(true);
    expect(pairCounter.escalationAllowed(id(11), id(2), "bypassPermissions")).toBe(false);

    // Renamed while loaded.
    pairCounter.renameSession(id(2), id(12));
    expect(pairCounter.messagedWith(id(11))).toEqual([id(12)]);
  });

  it("grants no escalation from a sidecar an older build wrote with allowances in it", () => {
    pairCounter.setAllowCreate(id(5));
    pairCounter.flush(); // creates the sidecar's folder
    writeFileSync(sidecar(), JSON.stringify({ version: 1, pairs: {}, allowCreate: [], allowEscalation: [`${id(3)}>${id(4)}`] }));
    pairCounter.reloadForTests();
    expect(pairCounter.escalationAllowed(id(3), id(4), "default")).toBe(false);
  });

  it("starts empty from an unreadable sidecar and forgets a deleted session", () => {
    pairCounter.record(id(1), id(2));
    pairCounter.forgetSession(id(2));
    expect(pairCounter.messagedWith(id(1))).toEqual([]);
    pairCounter.flush();
    writeFileSync(sidecar(), "{not json");
    pairCounter.reloadForTests();
    expect(pairCounter.count(id(1), id(2))).toBe(0);
  });
});
