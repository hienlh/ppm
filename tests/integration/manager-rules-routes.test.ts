/**
 * Manager rules through the real routes: assigning writes the rules file and its `.gitignore`
 * (git sees nothing new), a file that already existed is replaced by the template and offered for
 * approval, a tracked file is refused with the untrack message, a decision needs the held
 * change's hash, the user's own edit raises no decision but is always announced with its diff,
 * and the create route makes a Claude chat the manager in Settings' mode.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chatService } from "../../src/services/chat.service.ts";
import { configService } from "../../src/services/config.service.ts";
import { getSessionPermissionMode, getSessionTitle } from "../../src/services/db.service.ts";
import { managerChats } from "../../src/services/assistant-managers/manager-chats.service.ts";
import { putManagerChatRow } from "../../src/services/assistant-managers/manager-chats-db.ts";
import { getManagerRules } from "../../src/services/assistant-managers/manager-rules-db.ts";
import { createManagerRulesGuard, UNTRACK_MESSAGE } from "../../src/services/assistant-managers/manager-rules-guard.ts";
import { DEFAULT_MANAGER_RULES_TEMPLATE as T } from "../../src/services/assistant-managers/manager-rules-default-template.ts";
import { APPROVED_RULES_HEADING } from "../../src/services/assistant-managers/manager-context-entry.ts";
import { projectKey } from "../../src/services/project-name-for-path.ts";
import { createManagerRulesFixture } from "../helpers/manager-rules-fixture.ts";

const fx = createManagerRulesFixture("mgr-rules-routes");
const assistantBefore = configService.get("assistant");
beforeAll(() => fx.setup());
afterAll(() => {
  fx.teardown();
  configService.set("assistant", assistantBefore);
});
beforeEach(() => { fx.events.length = 0; });

const CLIENT = "- Keep client personal data and tax data out of reports; refer to ticket ids instead.";
const rulesOf = async (name: string) => (await fx.call("GET", `/api/assistant/managers/${name}/rules`)).json.data.rules;
const decide = (name: string, action: string, hash: string) =>
  fx.call("POST", `/api/assistant/managers/${name}/rules/decision`, { action, hash });

describe("assigning a manager", () => {
  it("writes the rules file and its .gitignore, and git sees nothing new under .ppm", async () => {
    const { project } = await fx.managed();
    expect(fx.readRules(project.path)).toBe(T);
    expect(readFileSync(join(project.path, ".ppm", ".gitignore"), "utf8")).toBe("/manager.md\n/.gitignore\n");
    expect(fx.git(project.path, "status", "--porcelain", "--", ".ppm")).toBe("");
    expect(await rulesOf(project.name)).toMatchObject({ approved: T, accepted: T, proposed: null, pendingHash: null, addedSince: [] });
    expect(fx.events).toEqual([]);
  });

  it("puts the template in force over an existing file and offers the old text for approval", async () => {
    const old = "# Our rules\n- Ship whenever the tests pass.\n";
    const { project, sessionId } = await fx.managed((p) => fx.writeRules(p.path, old));
    expect(fx.readRules(project.path)).toBe(T);
    const rules = await rulesOf(project.name);
    expect(rules).toMatchObject({ approved: T, accepted: T, proposed: old });
    expect(fx.events).toEqual([expect.objectContaining({ type: "rules_loosen_pending", reason: "existing_file", hash: rules.pendingHash })]);
    expect((await fx.call("GET", "/api/assistant/managers")).json.data.managers
      .find((m: { projectName: string }) => m.projectName === project.name)).toMatchObject({ rulesPending: true });

    expect((await decide(project.name, "approve", rules.pendingHash)).status).toBe(200);
    expect(fx.readRules(project.path)).toBe(old);
    chatService.invalidateSharedContext("claude", sessionId);
    const context = (await chatService.prepareSendOptions("claude", sessionId, "hi")).sharedContext ?? "";
    expect(context).toContain(`${APPROVED_RULES_HEADING}\n# Our rules\n- Ship whenever the tests pass.`);
  });

  it("refuses a file git tracks, with the untrack message, and leaves it alone", async () => {
    const shipped = "- The repository's own rules.\n";
    const { project, sessionId } = await fx.managed((p) => {
      fx.writeRules(p.path, shipped);
      fx.git(p.path, "add", "-f", ".ppm/manager.md");
    });
    expect(fx.readRules(project.path)).toBe(shipped);
    expect(fx.events).toEqual([expect.objectContaining({ type: "rules_unreadable", reason: "tracked", message: UNTRACK_MESSAGE })]);
    chatService.invalidateSharedContext("claude", sessionId);
    const context = (await chatService.prepareSendOptions("claude", sessionId, "hi")).sharedContext ?? "";
    expect(context).toContain(CLIENT);
    expect(context).not.toContain("The repository's own rules");
    expect(fx.readRules(project.path)).toBe(shipped);
    const put = await fx.call("PUT", `/api/assistant/managers/${project.name}/rules`, { text: "- mine\n" });
    expect(put).toMatchObject({ status: 400, json: { error: UNTRACK_MESSAGE } });
  });

  it("seeds on the clock it is given", async () => {
    const project = fx.project();
    const sessionId = fx.chat(project);
    putManagerChatRow({ projectKey: projectKey(project.path), projectPath: project.path, sessionId, providerId: "claude", assignedBy: "user", assignedAt: 1 });
    managerChats.invalidate();
    await createManagerRulesGuard({ now: () => 1_234 }).seed({ projectKey: projectKey(project.path), projectPath: project.path, projectName: project.name, sessionId });
    expect(getManagerRules(projectKey(project.path))).toMatchObject({ approved: T, accepted: T, approvedAt: 1_234 });
  });
});

describe("deciding a held change", () => {
  it("refuses a stale hash, applies the right one, and the next turn carries it", async () => {
    const { project, sessionId } = await fx.managed();
    fx.writeRules(project.path, T.replace(`${CLIENT}\n`, ""));
    await chatService.prepareSendOptions("claude", sessionId, "hi");
    const { pendingHash } = await rulesOf(project.name);
    expect(pendingHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await decide(project.name, "approve", "0".repeat(64))).toMatchObject({ status: 400, json: { error: "That rules change is no longer waiting" } });
    expect(fx.readRules(project.path)).toBe(T);
    expect((await decide(project.name, "approve", pendingHash)).status).toBe(200);
    expect(await decide(project.name, "approve", pendingHash)).toMatchObject({ status: 400 });
    chatService.invalidateSharedContext("claude", sessionId);
    const context = (await chatService.prepareSendOptions("claude", sessionId, "hi")).sharedContext ?? "";
    expect(context).toContain(APPROVED_RULES_HEADING);
    expect(context).not.toContain(CLIENT);
    expect(fx.events.filter((e) => e.type === "rules_decided")).toEqual([expect.objectContaining({ action: "approve", hash: pendingHash })]);
  });

  it("reverts: nothing waits any more and the rules in force stay", async () => {
    const { project, sessionId } = await fx.managed();
    fx.writeRules(project.path, `${T}Exception: staging needs no card.\n`);
    await chatService.prepareSendOptions("claude", sessionId, "hi");
    const { pendingHash } = await rulesOf(project.name);
    expect((await decide(project.name, "revert", pendingHash)).status).toBe(200);
    expect(await rulesOf(project.name)).toMatchObject({ proposed: null, pendingHash: null, accepted: T });
    expect(fx.readRules(project.path)).toBe(T);
  });
});

describe("the user's own edit", () => {
  it("writes the file and both blocks, raises no decision and always announces the diff", async () => {
    const { project, sessionId } = await fx.managed();
    const text = `${T.replace(`${CLIENT}\n`, "")}- Always run the linter.\n`;
    const put = await fx.call("PUT", `/api/assistant/managers/${project.name}/rules`, { text });
    expect(put.status).toBe(200);
    expect(fx.readRules(project.path)).toBe(text);
    expect(await rulesOf(project.name)).toMatchObject({ approved: text, accepted: text, pendingHash: null });
    expect(fx.events).toEqual([expect.objectContaining({ type: "rules_edited", added: ["- Always run the linter."], removed: [CLIENT] })]);
    chatService.invalidateSharedContext("claude", sessionId);
    expect((await chatService.prepareSendOptions("claude", sessionId, "hi")).sharedContext).toContain("- Always run the linter.");
    expect(fx.events.some((e) => e.type === "rules_loosen_pending")).toBe(false);
  });

  it("refuses text over the size limit", async () => {
    const { project } = await fx.managed();
    expect((await fx.call("PUT", `/api/assistant/managers/${project.name}/rules`, { text: "x".repeat(17 * 1024) })).status).toBe(400);
  });
});

describe("creating a manager chat", () => {
  it("makes a new Claude chat titled Manager the project's manager, in Settings' mode, with the files", async () => {
    configService.set("assistant", { ...configService.get("assistant"), manager_default_mode: "plan" });
    const project = fx.project();
    const res = await fx.call("POST", `/api/assistant/managers/${project.name}/create`, {});
    expect(res.status).toBe(201);
    const { sessionId } = res.json.data;
    expect(fx.created).toContain(sessionId);
    expect(managerChats.managerFor(project.path)?.sessionId).toBe(sessionId);
    expect(getSessionPermissionMode(sessionId)).toBe("plan");
    expect(getSessionTitle(sessionId)).toBe("Manager");
    expect(existsSync(join(project.path, ".ppm", "manager.md"))).toBe(true);
    expect((await fx.call("POST", "/api/assistant/managers/no-such-project/create", {})).status).toBe(404);
  });
});
