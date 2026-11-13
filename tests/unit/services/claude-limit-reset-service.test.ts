import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { setKeyPath } from "../../../src/lib/account-crypto.ts";
import { accountService } from "../../../src/services/account.service.ts";
import { CLAUDE_CLI_VERSION } from "../../../src/services/claude-cli-identity.ts";
import {
  LimitResetRefusedError,
  spendClaudeLimitReset,
  type ClaimAnswer,
  type LimitResetPorts,
} from "../../../src/services/claude-limit-reset.service.ts";
import { parseClaudeLimitResets } from "../../../src/shared/claude-limit-resets.ts";
import type { ClaudeUsage } from "../../../src/services/claude-usage.service.ts";

const keyPath = resolve(tmpdir(), `ppm-test-limit-reset-${process.pid}.key`);
setKeyPath(keyPath);

function grant(over: Record<string, unknown> = {}) {
  return {
    id: "full-reset-2611", label: "One full limit reset", resets_total: 1, resets_left: 1, ends_at: "2099-01-01T00:00:00Z",
    clears: ["five_hour", "seven_day"], paused: false, usable_now: true, use_requires_limit: false,
    percent_used: { five_hour: 100 }, blocking: [], type: "full", gives_back_weekly: false, ...over,
  };
}
const usage = (grants: unknown[]): ClaudeUsage => ({
  limitResets: parseClaudeLimitResets({ cedar_ember: { eligible: true, at_limit: true, exhausted: ["five_hour"], grants, weekly_resets_at: "2026-11-15T00:00:00Z" } }),
});

function fakes(live: ClaudeUsage | Error, answer: ClaimAnswer = { result: "reset", resetsLeft: 0 }) {
  const claims: Array<{ org: string; grantId: string; requestId: string }> = [];
  let refreshes = 0;
  const ports: LimitResetPorts = {
    token: async () => "sk-ant-oat01-fake",
    organization: async () => "org-uuid",
    readUsage: async () => { if (live instanceof Error) throw live; return live; },
    claim: async (_t, org, grantId, requestId) => { claims.push({ org, grantId, requestId }); return answer; },
    refresh: async () => { refreshes++; return {}; },
  };
  return { ports, claims, refreshes: () => refreshes };
}

let accountId: string;
beforeEach(() => {
  setDb(openTestDb());
  accountId = accountService.add({ email: "w@test", accessToken: "sk-ant-oat01-x", refreshToken: "r", expiresAt: Math.floor(Date.now() / 1000) + 3600, label: "Work" }).id;
});
afterEach(() => {
  setDb(openTestDb());
  if (existsSync(keyPath)) unlinkSync(keyPath);
});

const refusal = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(LimitResetRefusedError);
  return e as LimitResetRefusedError;
};

describe("spendClaudeLimitReset", () => {
  it("claims the grant Anthropic lists as usable now, once, and puts a parked account back in rotation", async () => {
    accountService.setCooldown(accountId, Date.now() + 3_600_000);
    const f = fakes(usage([grant()]));
    const r = await spendClaudeLimitReset(accountId, "full-reset-2611", f.ports);
    expect(r).toMatchObject({ result: "reset", kind: "full", resetsLeft: 0, weeklyResetsAt: "2026-11-15T00:00:00Z" });
    expect(f.claims).toHaveLength(1);
    expect(f.claims[0]).toMatchObject({ org: "org-uuid", grantId: "full-reset-2611" });
    expect(f.claims[0]!.requestId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(f.refreshes()).toBe(1);
    expect(accountService.list().find((a) => a.id === accountId)!.status).toBe("active");
  });

  it("refuses, without claiming, a grant the live read no longer offers or calls unusable", async () => {
    const gone = fakes(usage([grant({ id: "other" })]));
    expect((await refusal(spendClaudeLimitReset(accountId, "full-reset-2611", gone.ports))).message).toBe("Work no longer has that reset. The list has been refreshed.");
    const blocked = fakes(usage([grant({ usable_now: false, blocking: ["seven_day"] })]));
    const e = await refusal(spendClaudeLimitReset(accountId, "full-reset-2611", blocked.ports));
    expect(e.status).toBe(409);
    expect(e.message).toBe("Work's full reset can't be used while you're at your weekly limit. Nothing was used.");
    const unread = fakes(new Error("Usage API returned 500"));
    expect((await refusal(spendClaudeLimitReset(accountId, "full-reset-2611", unread.ports))).status).toBe(502);
    expect([...gone.claims, ...blocked.claims, ...unread.claims]).toEqual([]);
  });

  it("refuses a missing grant id, an unknown account and a second click while the first is in flight", async () => {
    const f = fakes(usage([grant()]));
    expect((await refusal(spendClaudeLimitReset(accountId, undefined, f.ports))).status).toBe(400);
    expect((await refusal(spendClaudeLimitReset("nope", "full-reset-2611", f.ports))).status).toBe(404);
    let release!: () => void;
    const slow = { ...f.ports, readUsage: () => new Promise<ClaudeUsage>((res) => { release = () => res(usage([grant()])); }) };
    const first = spendClaudeLimitReset(accountId, "full-reset-2611", slow);
    expect((await refusal(spendClaudeLimitReset(accountId, "full-reset-2611", f.ports))).message).toContain("already in progress");
    release();
    expect((await first).result).toBe("reset");
    expect(f.claims).toHaveLength(1);
  });

  it("passes Anthropic's other answers through and leaves the account's status alone", async () => {
    accountService.setCooldown(accountId, Date.now() + 3_600_000);
    const f = fakes(usage([grant()]), { result: "already_used", reason: "already_used" });
    expect((await spendClaudeLimitReset(accountId, "full-reset-2611", f.ports)).result).toBe("already_used");
    expect(accountService.list().find((a) => a.id === accountId)!.status).toBe("cooldown");
  });
});

it("goes out as the Claude Code the bundled SDK ships", () => {
  const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, "../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8"));
  expect(CLAUDE_CLI_VERSION).toBe(pkg.claudeCodeVersion);
});
