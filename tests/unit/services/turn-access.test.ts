import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { configService } from "../../../src/services/config.service.ts";
import { _setClaudeProjectsRoot } from "../../../src/services/agent-transcript/claude-projects-root.ts";
import { resolveTurnAccess, type TurnCaller } from "../../../src/services/session-turns/turn-access.ts";
import { recordTurnGrants } from "../../../src/services/session-turns/turn-grant-ledger.ts";
import type { TurnReference } from "../../../src/shared/chat-turn-ref.ts";
import { claude, lines } from "./session-turn-fixtures.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ppm-turn-access-")));
const OWN = { name: "turn-access-own", path: join(root, "own") };
const OTHER = { name: "turn-access-other", path: join(root, "other") };
const slugDir = (p: string) => join(root, "projects", p.replace(/[/\\:.]/g, "-"));
const P = (n: number) => `66666666-0000-4000-8000-00000000000${n}`;

const ownSession = randomUUID();
const otherSession = randomUUID();
const caller = (): TurnCaller => ({ sessionId: randomUUID(), projectPath: OWN.path, projectName: OWN.name });
const ref = (turnId: string, over: Partial<TurnReference> = {}): TurnReference => ({
  version: 1, projectName: OTHER.name, providerId: "claude", sessionId: otherSession, turnId, n: 1,
  title: "t", prompt: "p", at: "2026-11-01T00:00:00.000Z", ...over,
});

function writeSession(projectPath: string, id: string): void {
  mkdirSync(slugDir(projectPath), { recursive: true });
  writeFileSync(join(slugDir(projectPath), `${id}.jsonl`), lines(
    claude.prompt("first", P(1)), claude.assistant("one"),
    claude.prompt("second", P(2)), claude.assistant("two"),
  ));
}

beforeAll(() => {
  for (const p of [OWN, OTHER]) mkdirSync(p.path, { recursive: true });
  _setClaudeProjectsRoot(join(root, "projects"));
  writeSession(OWN.path, ownSession);
  writeSession(OTHER.path, otherSession);
  configService.set("projects", [...configService.get("projects").filter((p) => p.name !== OWN.name && p.name !== OTHER.name), OWN, OTHER]);
});

afterAll(() => {
  _setClaudeProjectsRoot(null);
  configService.set("projects", configService.get("projects").filter((p) => p.name !== OWN.name && p.name !== OTHER.name));
  rmSync(root, { recursive: true, force: true });
});

describe("turn access", () => {
  it("own project: any session it owns, by ids or range", () => {
    const c = caller();
    const byIds = resolveTurnAccess(c, ownSession, undefined, { turnIds: [P(1)] });
    expect(byIds).toMatchObject({ ok: true, turnIds: [P(1)], denied: [], target: { providerId: "claude", crossProject: false, projectName: OWN.name } });
    expect(resolveTurnAccess(c, ownSession, OWN.name, { range: { from: 1, to: 2 } })).toMatchObject({ ok: true });
    expect(resolveTurnAccess(c, "bad id!", undefined, { turnIds: [P(1)] })).toMatchObject({ ok: false, code: "invalid" });
    expect(resolveTurnAccess(c, ownSession, undefined, { turnIds: ["../x"] })).toMatchObject({ ok: false, code: "invalid" });
    expect(resolveTurnAccess(c, randomUUID(), undefined, { turnIds: [P(1)] })).toMatchObject({ ok: false, code: "session_missing" });
  });

  it("another project: refused until the ledger holds the exact turn, and never for a range", () => {
    const c = caller();
    expect(resolveTurnAccess(c, otherSession, undefined, { turnIds: [P(1)] })).toMatchObject({ ok: false, code: "session_missing" });
    expect(resolveTurnAccess(c, otherSession, OTHER.name, { turnIds: [P(1)] })).toMatchObject({ ok: false, code: "not_permitted" });

    recordTurnGrants(c.sessionId, [ref(P(1))]);
    const named = resolveTurnAccess(c, otherSession, OTHER.name, { turnIds: [P(1), P(2)] });
    expect(named).toMatchObject({
      ok: true, turnIds: [P(1)], denied: [{ turnId: P(2), code: "not_permitted" }],
      target: { crossProject: true, projectName: OTHER.name, ref: { projectPath: OTHER.path } },
    });
    // The project may be left out: the ledger says where the linked turn lives.
    expect(resolveTurnAccess(c, otherSession, undefined, { turnIds: [P(1)] })).toMatchObject({ ok: true, turnIds: [P(1)] });
    expect(resolveTurnAccess(c, otherSession, OTHER.name, { range: { from: 1, to: 1 } })).toMatchObject({ ok: false, code: "not_permitted" });
    expect(resolveTurnAccess(c, otherSession, undefined, { range: { from: 1, to: 1 } })).toMatchObject({ ok: false, code: "not_permitted" });
    // Another chat holds no grant.
    expect(resolveTurnAccess(caller(), otherSession, OTHER.name, { turnIds: [P(1)] })).toMatchObject({ ok: false, code: "not_permitted" });
  });

  it("pins the grant's project: the same ids in a different project are not reachable through it", () => {
    const c = caller();
    // A grant naming the own project's session id under the other project's name.
    recordTurnGrants(c.sessionId, [ref(P(1), { sessionId: ownSession })]);
    expect(resolveTurnAccess(c, ownSession, OTHER.name, { turnIds: [P(1)] })).toMatchObject({ ok: false, code: "session_missing" });
    // And a grant for a project PPM no longer has is refused.
    recordTurnGrants(c.sessionId, [ref(P(2), { projectName: "gone-project" })]);
    expect(resolveTurnAccess(c, otherSession, "gone-project", { turnIds: [P(2)] })).toMatchObject({ ok: false, code: "not_permitted" });
  });
});
