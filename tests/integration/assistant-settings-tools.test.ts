/**
 * The PPM Assistant's settings tools through the production path: the real handlers, the real
 * catalog, and the Settings panes' own routers reached through the settings family's route caller.
 * Only the asker is stubbed (what the user — or Full mode — answers), plus one real Full-mode run.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { configService } from "../../src/services/config.service.ts";
import { chatService } from "../../src/services/chat.service.ts";
import { setSessionAssistant } from "../../src/services/db.service.ts";
import { getAssistantSettings } from "../../src/services/assistant/assistant-settings.service.ts";
import { readVoiceSettings, updateVoiceSettings } from "../../src/services/voice-message/voice-settings.ts";
import { routeCallerFor, type ToolContext } from "../../src/services/assistant-mcp/assistant-tool-family.ts";
import type { ApprovalAsk, ApprovalVerdict } from "../../src/services/assistant-mcp/assistant-approval-broker.ts";
import { approvalAskerFor, createApprovalBroker } from "../../src/services/assistant-mcp/assistant-approval-broker.ts";
import { assistantFullMode } from "../../src/services/assistant/assistant-full-mode-live.ts";
import { assistantTurnProvenance } from "../../src/services/assistant/assistant-turn-provenance.ts";
import { SETTINGS_TOOL_HANDLERS } from "../../src/services/assistant-settings-tools/settings-tools.ts";
import { listSettingChanges, recordSettingChange } from "../../src/services/assistant-settings-tools/settings-change-log.ts";
import { undoSettingChange } from "../../src/services/assistant-settings-tools/settings-apply.ts";
import { assistantToolOff } from "../../src/services/assistant-mcp/assistant-mcp-endpoint.ts";

const CANARY_BOT = "123456:CANARY-bot-token-zz9";
const CANARY_NTFY = "tk_CANARYntfyTOKEN0042";

type Ask = (ask: ApprovalAsk) => Promise<ApprovalVerdict>;
const asked: ApprovalAsk[] = [];
const allowAuto: Ask = async (a) => { asked.push(a); return { verdict: "approved", auto: true }; };
const allowCard: Ask = async (a) => { asked.push(a); return { verdict: "approved" }; };
const deny: Ask = async (a) => { asked.push(a); return { verdict: "denied", reason: "no" }; };

function ctx(ask: Ask, startedBy: "user_ppm" | "user_telegram" = "user_ppm"): ToolContext {
  return { sessionId: "assistant-int", ask, callRoute: routeCallerFor("settings"), provenanceAtCall: { startedBy, untrusted: false } };
}

const text = (r: unknown): string => ((r as { content: Array<{ text: string }> }).content[0]!.text);
const json = (r: unknown) => JSON.parse(text(r));
const call = (tool: string, c: ToolContext, args: Record<string, unknown>) => SETTINGS_TOOL_HANDLERS[tool]!(c, args);

let savedAssistant: unknown;
beforeEach(() => {
  asked.length = 0;
  savedAssistant = configService.get("assistant");
  configService.set("assistant", { ...getAssistantSettings(), settings_tools: true } as never);
  configService.set("telegram", { bot_token: CANARY_BOT } as never);
  configService.set("ntfy", { server: "https://ntfy.sh", topic: "t", token: CANARY_NTFY } as never);
  updateVoiceSettings({ enabled: true, cleanupEnabled: true });
});
afterEach(() => {
  configService.set("assistant", savedAssistant as never);
});

describe("the switch", () => {
  it("hides and refuses every settings tool while off", async () => {
    configService.set("assistant", { ...getAssistantSettings(), settings_tools: false } as never);
    expect(assistantToolOff("settings_set")).toContain("off");
    expect(assistantToolOff("projects_list")).toBeNull();
    const r = await call("settings_set", ctx(allowAuto), { changes: [{ key: "voice.cleanup_enabled", value: false }] });
    expect(text(r)).toContain("off");
    expect(readVoiceSettings().transcript_fix).toEqual({ composer: "haiku", telegram: "haiku" });
  });
});

describe("settings_set", () => {
  it("changes a direct setting through its pane's route and records it", async () => {
    const r = json(await call("settings_set", ctx(allowAuto, "user_telegram"), { changes: [{ key: "voice.cleanup_enabled", value: false }] }));
    expect(r.outcome).toBe("changed");
    expect(r.approval).toBe("full");
    expect(readVoiceSettings().transcript_fix).toEqual({ composer: "hints", telegram: "hints" });
    expect(asked[0]!.alwaysAsk).toBeUndefined();
    // The one switch over two places is made and logged as one change per place.
    const rows = listSettingChanges({ limit: 2 });
    expect(rows.map((r) => r.key).sort()).toEqual(["voice.transcript_fix.composer", "voice.transcript_fix.telegram"]);
    for (const row of rows) {
      expect(row).toMatchObject({ beforeText: "Tidied by Claude Haiku", afterText: "As heard, with hints", origin: "telegram", approval: "full" });
    }
  });

  it("changes one surface's choice between Haiku and hints, leaving the other", async () => {
    const r = json(await call("settings_set", ctx(allowAuto), { changes: [{ key: "voice.transcript_fix.telegram", value: "hints" }] }));
    expect(r.outcome).toBe("changed");
    expect(readVoiceSettings().transcript_fix).toEqual({ composer: "haiku", telegram: "hints" });
    const [row] = listSettingChanges({ limit: 1 });
    expect(row).toMatchObject({ key: "voice.transcript_fix.telegram", beforeText: "Tidied by Claude Haiku", afterText: "As heard, with hints" });
    expect(text(await call("settings_set", ctx(allowAuto), { changes: [{ key: "voice.transcript_fix.composer", value: "tidy" }] }))).not.toContain('"changed"');
    expect(readVoiceSettings().transcript_fix.composer).toBe("haiku");
  });

  it("asks with an always-ask reason for a permission setting, and changes nothing when denied", async () => {
    const before = getAssistantSettings().act_on_own;
    const r = await call("settings_set", ctx(deny), { changes: [{ key: "assistant.act_on_own", value: !before }] });
    expect(text(r)).toContain("declined");
    expect(asked[0]!.alwaysAsk).toContain("asks even in Full mode");
    expect(getAssistantSettings().act_on_own).toBe(before);
  });

  it("writes a whole-object setting without losing the others", async () => {
    configService.set("assistant", { ...getAssistantSettings(), instructions: "keep me" } as never);
    const r = json(await call("settings_set", ctx(allowCard), { changes: [{ key: "assistant.quiet_hours.start", value: "21:30" }] }));
    expect(r.outcome).toBe("changed");
    expect(getAssistantSettings().quiet_hours.start).toBe("21:30");
    expect(getAssistantSettings().instructions).toBe("keep me");
    expect(getAssistantSettings().settings_tools).toBe(true);
  });

  it("is stale, and writes nothing, when the value moved while the card waited", async () => {
    const moving: Ask = async () => { updateVoiceSettings({ cleanupEnabled: false }); return { verdict: "approved" }; };
    const r = json(await call("settings_set", ctx(moving), { changes: [{ key: "voice.cleanup_enabled", value: false }] }));
    expect(r.outcome).toBe("stale");
  });

  it("refuses a secret, an unknown key and a bad value before asking", async () => {
    for (const [key, value] of [["telegram.bot_token", "x"], ["ai.providers.claude.api_key", "x"], ["no.such", 1], ["voice.cleanup_enabled", "yes"]] as const) {
      const r = await call("settings_set", ctx(allowAuto), { changes: [{ key, value }] });
      expect((r as { isError?: boolean }).isError).toBe(true);
    }
    expect(asked).toHaveLength(0);
  });
});

describe("undo of the switch over both places", () => {
  const undo = (id: number) => undoSettingChange(id, { callRoute: routeCallerFor("settings"), approval: "user", origin: "ppm", sessionId: null });

  it("gives each place back its own old choice, not one value for both", async () => {
    updateVoiceSettings({ transcriptFix: { composer: "haiku", telegram: "hints" } });
    const set = json(await call("settings_set", ctx(allowAuto), { changes: [{ key: "voice.cleanup_enabled", value: true }] }));
    // Only the place that changed is a change: the chat box was already on Haiku.
    expect(set.changes.map((c: { key: string }) => c.key)).toEqual(["voice.transcript_fix.telegram"]);
    expect(readVoiceSettings().transcript_fix).toEqual({ composer: "haiku", telegram: "haiku" });
    for (const c of set.changes) expect((await undo(c.changeId)).ok).toBe(true);
    expect(readVoiceSettings().transcript_fix).toEqual({ composer: "haiku", telegram: "hints" });

    updateVoiceSettings({ transcriptFix: { composer: "hints", telegram: "haiku" } });
    const off = json(await call("settings_set", ctx(allowAuto), { changes: [{ key: "voice.cleanup_enabled", value: false }] }));
    expect(readVoiceSettings().transcript_fix).toEqual({ composer: "hints", telegram: "hints" });
    for (const c of off.changes) expect((await undo(c.changeId)).ok).toBe(true);
    expect(readVoiceSettings().transcript_fix).toEqual({ composer: "hints", telegram: "haiku" });
  });

  it("refuses to name the switch and one of its places in one call", async () => {
    const r = await call("settings_set", ctx(allowAuto), {
      changes: [{ key: "voice.transcript_fix.composer", value: "hints" }, { key: "voice.cleanup_enabled", value: true }],
    });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(readVoiceSettings().transcript_fix).toEqual({ composer: "haiku", telegram: "haiku" });
  });

  it("still undoes a row written under the switch before it was split", async () => {
    // Such a row was written while one switch drove both places, so its old value is both's.
    updateVoiceSettings({ cleanupEnabled: false });
    const legacy = recordSettingChange({
      sessionId: null, origin: "ppm", approval: "full", kind: "setting", key: "voice.cleanup_enabled",
      label: "Voice Input → Haiku clean-up", before: true, after: false, beforeText: "On", afterText: "Off",
    });
    expect((await undo(legacy.id)).ok).toBe(true);
    expect(readVoiceSettings().transcript_fix).toEqual({ composer: "haiku", telegram: "haiku" });
  });
});

describe("undo", () => {
  it("puts the old value back, then refuses once it moved again", async () => {
    const set = json(await call("settings_set", ctx(allowAuto), { changes: [{ key: "notifications.delay_seconds", value: 120 }] }));
    const id = set.changes[0].changeId as number;
    const undone = await undoSettingChange(id, { callRoute: routeCallerFor("settings"), approval: "user", origin: "ppm", sessionId: null });
    expect(undone.ok).toBe(true);
    const undoRow = listSettingChanges({ limit: 1 })[0]!;
    expect(undoRow).toMatchObject({ undoes: id, approval: "user" });
    // An undo is not itself offered for undo: the setting is changed again instead.
    const again0 = await undoSettingChange(undoRow.id, { callRoute: routeCallerFor("settings"), approval: "user", origin: "ppm", sessionId: null });
    expect(!again0.ok && again0.block?.reason).toBe("not_undoable");

    const again = json(await call("settings_set", ctx(allowAuto), { changes: [{ key: "notifications.delay_seconds", value: 300 }] }));
    await call("settings_set", ctx(allowAuto), { changes: [{ key: "notifications.delay_seconds", value: 30 }] });
    const refused = await undoSettingChange(again.changes[0].changeId, { callRoute: routeCallerFor("settings"), approval: "user", origin: "ppm", sessionId: null });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.block?.reason).toBe("moved");
  });
});

describe("two undos at once", () => {
  it("writes and records one of them", async () => {
    const set = json(await call("settings_set", ctx(allowAuto), { changes: [{ key: "notifications.delay_seconds", value: 300 }] }));
    const id = set.changes[0].changeId as number;
    const opts = { callRoute: routeCallerFor("settings"), approval: "user" as const, origin: "ppm" as const, sessionId: null };
    const outs = await Promise.all([undoSettingChange(id, opts), undoSettingChange(id, opts)]);
    expect(outs.filter((o) => o.ok)).toHaveLength(1);
    expect(listSettingChanges({ limit: 10 }).filter((r) => r.undoes === id)).toHaveLength(1);
  });
});

describe("secrets never leave", () => {
  it("answers set/not set, and no canary reaches a tool's answer or the history", async () => {
    const got = text(await call("settings_get", ctx(allowAuto), { keys: ["telegram.bot_token", "ntfy.token", "auth.token"] }));
    expect(got).toContain('"set": true');
    const area = text(await call("settings_get", ctx(allowAuto), { area: "notifications" }));
    const history = text(await call("settings_history", ctx(allowAuto), { limit: 50 }));
    for (const out of [got, area, history]) {
      expect(out).not.toContain(CANARY_BOT);
      expect(out).not.toContain(CANARY_NTFY);
    }
  });
});

describe("the route gate", () => {
  it("keeps the family to the panes' own writes and the catalog's config keys", async () => {
    const callRoute = routeCallerFor("settings");
    expect((await callRoute("PUT", "/api/settings/config-key", { key: "port", value: 9999 })).status).toBe(403);
    expect((await callRoute("PUT", "/api/settings/auth/password", { password: "x" })).code).toBe("route_not_allowed");
    expect((await callRoute("PUT", "/api/settings/ui-prefs", { wordWrap: true })).code).toBe("route_not_allowed");
  });
});

describe("Full mode, end to end", () => {
  let sessionId = "";
  beforeEach(async () => {
    configService.set("assistant", { ...getAssistantSettings(), permission_mode: "full" } as never);
    assistantFullMode.reset();
    sessionId = (await chatService.createSession("claude", {})).id;
    setSessionAssistant(sessionId);
    assistantTurnProvenance.noteMessage({ sessionId, text: "change it", origin: "ws" });
  });
  afterEach(() => assistantTurnProvenance.turnEnded(sessionId));

  it("changes a direct setting with no card, and shows one for a permission setting", async () => {
    let cards = 0;
    const ask = approvalAskerFor(sessionId, undefined, createApprovalBroker({ deliver: () => { cards++; return 0; } }), () => false);
    const c: ToolContext = { sessionId, ask, callRoute: routeCallerFor("settings"), provenanceAtCall: { startedBy: "user_ppm", untrusted: false } };
    const r = json(await call("settings_set", c, { changes: [{ key: "theme.mode", value: "light" }] }));
    expect(r).toMatchObject({ outcome: "changed", approval: "full" });
    expect(cards).toBe(0);
    const before = getAssistantSettings().auto_readonly_commands;
    const asked = await call("settings_set", c, { changes: [{ key: "assistant.auto_readonly_commands", value: !before }] });
    expect(cards).toBe(1);
    // The stub delivers to nobody, so the card is never answered and nothing changes.
    expect((asked as { isError?: boolean }).isError).toBe(true);
    expect(getAssistantSettings().auto_readonly_commands).toBe(before);
  });

  it("asks to lower a history limit or silence approval alerts, and not the other way round", async () => {
    let cards = 0;
    const ask = approvalAskerFor(sessionId, undefined, createApprovalBroker({ deliver: () => { cards++; return 0; } }), () => false);
    const c: ToolContext = { sessionId, ask, callRoute: routeCallerFor("settings"), provenanceAtCall: { startedBy: "user_ppm", untrusted: false } };
    const days = configService.get("session_trace")!.retention_days;
    // Raising: no card, changed.
    expect(json(await call("settings_set", c, { changes: [{ key: "session_trace.retention_days", value: days + 5 }] }))).toMatchObject({ outcome: "changed", approval: "full" });
    expect(cards).toBe(0);
    // Lowering back to where it was: a card (unanswered here), nothing changed.
    const lower = await call("settings_set", c, { changes: [{ key: "session_trace.retention_days", value: days }] });
    expect(cards).toBe(1);
    expect((lower as { isError?: boolean }).isError).toBe(true);
    expect(configService.get("session_trace")!.retention_days).toBe(days + 5);
    // Approval alerts: switching off asks, switching on does not.
    const off = await call("settings_set", c, { changes: [{ key: "notifications.events.approval_request", value: false }] });
    expect(cards).toBe(2);
    expect((off as { isError?: boolean }).isError).toBe(true);
    configService.set("notifications", { ...(configService.get("notifications") ?? {}), events: { ...((configService.get("notifications") as { events?: object } | undefined)?.events ?? {}), approval_request: false } } as never);
    expect(json(await call("settings_set", c, { changes: [{ key: "notifications.events.approval_request", value: true }] }))).toMatchObject({ outcome: "changed", approval: "full" });
    expect(cards).toBe(2);
  });
});
