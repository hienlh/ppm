import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import { setSessionMigratedTo } from "../../../src/services/db.service.ts";
import {
  deleteTurnGrants, findTurnGrant, MAX_GRANTS, recordTurnGrants, turnGrantsFor,
} from "../../../src/services/session-turns/turn-grant-ledger.ts";
import type { TurnReference } from "../../../src/shared/chat-turn-ref.ts";

const ref = (turnId: string, over: Partial<TurnReference> = {}): TurnReference => ({
  version: 1, projectName: "alpha", providerId: "claude", sessionId: "aaaaaaaa-0000-4000-8000-0000000000aa",
  turnId, n: 1, title: "t", prompt: "p", at: "2026-11-01T00:00:00.000Z", ...over,
});
const T = (i: number) => `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`;
const file = (sessionId: string) => join(getPpmDir(), "session-turn-grants", `${sessionId}.json`);

describe("turn grant ledger", () => {
  it("records exact turns, in the session's own file, and finds only those", () => {
    const caller = randomUUID();
    recordTurnGrants(caller, [ref(T(1)), ref(T(2), { projectName: "beta" })]);
    expect(existsSync(file(caller))).toBe(true);
    expect(findTurnGrant(caller, { sessionId: ref(T(1)).sessionId, turnId: T(1) })?.projectName).toBe("alpha");
    expect(findTurnGrant(caller, { projectName: "alpha", sessionId: ref(T(2)).sessionId, turnId: T(2) })).toBeUndefined();
    expect(findTurnGrant(caller, { sessionId: ref(T(1)).sessionId, turnId: T(3) })).toBeUndefined();
    expect(findTurnGrant(randomUUID(), { sessionId: ref(T(1)).sessionId, turnId: T(1) })).toBeUndefined();
  });

  it("keeps at most MAX_GRANTS, dropping the oldest, and a re-sent turn counts as new", () => {
    const caller = randomUUID();
    recordTurnGrants(caller, [ref(T(0))]);
    for (let i = 1; i <= MAX_GRANTS; i += 10) recordTurnGrants(caller, Array.from({ length: 10 }, (_, k) => ref(T(i + k))));
    const grants = turnGrantsFor(caller);
    expect(grants.length).toBe(MAX_GRANTS);
    expect(grants.some((g) => g.turnId === T(0))).toBe(false);
    recordTurnGrants(caller, [ref(T(1))]);
    expect(turnGrantsFor(caller).at(-1)?.turnId).toBe(T(1));
  });

  it("a session renamed after the grant still finds it, and deleting removes every file", () => {
    const draft = randomUUID();
    const thread = randomUUID();
    recordTurnGrants(draft, [ref(T(1))]);
    setSessionMigratedTo(draft, thread);
    recordTurnGrants(thread, [ref(T(2))]);
    for (const id of [draft, thread]) {
      expect(turnGrantsFor(id).map((g) => g.turnId).sort()).toEqual([T(1), T(2)]);
    }
    deleteTurnGrants(thread);
    expect(existsSync(file(draft))).toBe(false);
    expect(existsSync(file(thread))).toBe(false);
  });

  it("ignores a corrupt or tampered file instead of trusting it", () => {
    const caller = randomUUID();
    recordTurnGrants(caller, [ref(T(1))]);
    writeFileSync(file(caller), "{not json");
    expect(turnGrantsFor(caller)).toEqual([]);
    writeFileSync(file(caller), JSON.stringify({ version: 1, grants: [{ ...ref(T(1)), turnId: "../../x" }, { projectName: "a", providerId: "claude", sessionId: ref(T(1)).sessionId, turnId: T(5), grantedAt: "now" }] }));
    expect(turnGrantsFor(caller).map((g) => g.turnId)).toEqual([T(5)]);
    // A later write replaces the file whole.
    recordTurnGrants(caller, [ref(T(6))]);
    expect(JSON.parse(readFileSync(file(caller), "utf8")).grants.map((g: { turnId: string }) => g.turnId)).toEqual([T(5), T(6)]);
  });

  it("refuses ids that are not session ids", () => {
    recordTurnGrants("../escape", [ref(T(1))]);
    expect(existsSync(join(getPpmDir(), "escape.json"))).toBe(false);
    expect(turnGrantsFor("../escape")).toEqual([]);
  });
});
