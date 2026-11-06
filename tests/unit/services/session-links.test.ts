import { beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, setSessionMigratedTo } from "../../../src/services/db.service.ts";
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
    pairCounter.setAllowEscalation(id(1), id(2));
    expect(pairCounter.canCreateWithoutAsking(id(1))).toBe(true);
    expect(pairCounter.canCreateWithoutAsking(id(2))).toBe(false);
    expect(pairCounter.escalationAllowed(id(1), id(2))).toBe(true);
    expect(pairCounter.escalationAllowed(id(2), id(1))).toBe(false);
  });

  it("round-trips through the sidecar and follows renamed sessions", () => {
    pairCounter.record(id(1), id(2));
    pairCounter.grant(id(1), id(2), 5);
    pairCounter.setAllowCreate(id(1));
    pairCounter.setAllowEscalation(id(1), id(2));
    pairCounter.flush();
    expect(existsSync(sidecar())).toBe(true);
    expect(JSON.parse(readFileSync(sidecar(), "utf8")).version).toBe(1);

    // Renamed while the file sat on disk: read back under the new id.
    setSessionMigratedTo(id(1), id(11));
    pairCounter.reloadForTests();
    expect(pairCounter.count(id(11), id(2))).toBe(1);
    expect(pairCounter.remaining(id(11), id(2), 1)).toBe(5);
    expect(pairCounter.canCreateWithoutAsking(id(11))).toBe(true);
    expect(pairCounter.escalationAllowed(id(11), id(2))).toBe(true);

    // Renamed while loaded.
    pairCounter.renameSession(id(2), id(12));
    expect(pairCounter.messagedWith(id(11))).toEqual([id(12)]);
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
