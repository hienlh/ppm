/**
 * `chat_start` and `chat_answer_approval` act on the user's chats, so both ask first and act
 * only on approval: a new chat gets the mode a new chat gets in PPM unless the Assistant names
 * one (bypass flagged on the card), and an answer to another chat's card repeats exactly what
 * that card runs, is never given for a card PPM cannot show in full, and is never given twice.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configService } from "../../../src/services/config.service.ts";
import { getSessionModel, getSessionPermissionMode } from "../../../src/services/db.service.ts";
import { _setClaudeProjectsRoot } from "../../../src/services/agent-transcript/claude-projects-root.ts";
import { chatAnswerApproval, chatStart } from "../../../src/services/assistant-mcp/assistant-hub-tools.ts";
import type { AssistantChatDelivery } from "../../../src/services/assistant-mcp/assistant-chat-send.ts";
import type { ApprovalAsk, ApprovalVerdict, AskApproval } from "../../../src/services/assistant-mcp/assistant-approval-broker.ts";
import type { ChatControl, LiveApprovalCard } from "../../../src/services/chat-control/chat-control.ts";
import { approvalInput } from "../../../src/providers/codex-app-server/codex-approval-input.ts";
import { normalizeCodexQuestions } from "../../../src/shared/approval-questions.ts";

const text = (r: Record<string, unknown>) => (r.content as Array<{ text: string }>)[0]!.text;
const APPROVE: ApprovalVerdict = { verdict: "approved" };
const DENY: ApprovalVerdict = { verdict: "denied", reason: "The user declined." };

function asker(verdict: ApprovalVerdict, meanwhile?: () => void) {
  const asked: ApprovalAsk[] = [];
  const ask: AskApproval = async (a) => { asked.push(a); meanwhile?.(); return verdict; };
  return { asked, ask };
}

const SESSION = "0b6f6a3c-1a7b-4d7e-9b1a-2f0f6d8e9c11";
let root: string;
let savedProjects: unknown;
let savedAi: ReturnType<typeof configService.get<"ai">>;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-asst-hub-"));
  const project = join(root, "api");
  mkdirSync(project, { recursive: true });
  const claudeRoot = join(root, "claude-projects");
  const dir = join(claudeRoot, project.replace(/[/\\:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SESSION}.jsonl`), '{"type":"user"}\n');
  _setClaudeProjectsRoot(claudeRoot);
  savedProjects = configService.get("projects");
  configService.set("projects", [{ name: "api", path: project }]);
  savedAi = configService.get("ai");
  configService.set("ai", { ...savedAi, default_provider: "claude", providers: { ...savedAi.providers, claude: { ...savedAi.providers.claude!, permission_mode: "bypassPermissions" } } });
});
afterAll(() => {
  _setClaudeProjectsRoot(null);
  configService.set("projects", savedProjects as never);
  configService.set("ai", savedAi);
  rmSync(root, { recursive: true, force: true });
});

describe("chat_start", () => {
  function fakes(deliverError?: string) {
    const created: Array<Record<string, unknown>> = [];
    const sent: Array<{ sessionId: string; text: string; mode: string }> = [];
    const events: unknown[] = [];
    const delivery: AssistantChatDelivery = {
      inspect: () => { throw new Error("not used"); },
      deliver: async (target, t, mode) => {
        sent.push({ sessionId: target.sessionId, text: t, mode });
        return deliverError ? { ok: false, error: deliverError } : { ok: true, sessionId: target.sessionId };
      },
    };
    const create = async (input: Record<string, unknown>) => {
      created.push(input);
      return { id: crypto.randomUUID(), providerId: String(input.providerId), title: "", createdAt: "" };
    };
    return { created, sent, events, deps: { delivery, create: create as never, broadcast: (e: unknown) => events.push(e) } };
  }

  it("starts in the mode a new chat gets in PPM when none is named, and flags bypass on the card", async () => {
    const f = fakes();
    const { ask, asked } = asker(APPROVE);
    const result = await chatStart({ project: "api", text: "Run the test suite and fix failures" }, ask, f.deps);
    const out = JSON.parse(text(result));
    expect(out).toMatchObject({ started: true, project: "api", providerId: "claude", permissionMode: "bypassPermissions" });
    expect(getSessionPermissionMode(out.sessionId)).toBe("bypassPermissions");
    expect(f.created[0]).toMatchObject({ providerId: "claude", projectName: "api", adoptWarmSpare: false });
    expect(f.sent).toEqual([{ sessionId: out.sessionId, text: "Run the test suite and fix failures", mode: "bypassPermissions" }]);
    expect(f.events).toEqual([{ type: "sessions:list_changed", projectName: "api" }]);
    const card = asked[0]!.summary;
    expect(card.facts).toContainEqual({ label: "Runs in", value: "Bypass permissions — every tool runs without asking", tone: "warning" });
    expect(card.facts.find((x) => x.label === "Mode from")?.value).toContain("new chat gets when you open one in PPM");
    expect(card.warning).toContain("without asking");
    expect(card.body?.text).toBe("Run the test suite and fix failures");
  });

  it("uses the mode and model the Assistant names, with no bypass warning", async () => {
    const f = fakes();
    const { ask, asked } = asker(APPROVE);
    const out = JSON.parse(text(await chatStart({ project: "api", text: "hi", permissionMode: "default", model: "claude-sonnet-5", title: "Tidy <up>" }, ask, f.deps)));
    expect(getSessionPermissionMode(out.sessionId)).toBe("default");
    expect(getSessionModel(out.sessionId)).toBe("claude-sonnet-5");
    expect(asked[0]!.summary.warning).toBeUndefined();
    expect(asked[0]!.summary.facts).toContainEqual({ label: "Mode from", value: "chosen by the Assistant" });
    expect(f.created[0]!.title).toBe("Tidy up");
  });

  it("creates nothing when the user declines, and refuses bad input before asking", async () => {
    const f = fakes();
    const declined = await chatStart({ project: "api", text: "hi" }, asker(DENY).ask, f.deps);
    expect(declined.isError).toBe(true);
    expect(f.created).toHaveLength(0);
    for (const args of [
      { project: "nope", text: "hi" }, { project: "api", text: "" }, { project: "api", text: "hi", providerId: "gpt" },
      { project: "api", text: "hi", permissionMode: "yolo" }, { project: "api", text: "hi", model: "a b" },
    ]) {
      const { ask, asked } = asker(APPROVE);
      expect((await chatStart(args, ask, f.deps)).isError).toBe(true);
      expect(asked).toHaveLength(0);
    }
    expect(f.created).toHaveLength(0);
  });

  it("says which chat exists when its first message could not be sent", async () => {
    const f = fakes("provider unavailable");
    const result = await chatStart({ project: "api", text: "hi" }, asker(APPROVE).ask, f.deps);
    expect(result.isError).toBe(true);
    expect(JSON.parse(text(result))).toMatchObject({ started: true, sent: false, error: "provider unavailable" });
  });
});

describe("chat_answer_approval", () => {
  function fakeControl(initial: LiveApprovalCard | undefined, answerResult: "answered" | "stale" = "answered") {
    let card = initial;
    const answered: Array<{ requestId: string; answer: unknown; origin: string }> = [];
    const control = {
      liveState: () => ({ phase: "waiting", running: true, projectName: "api", providerId: "claude", queuedCards: 0, ...(card ? { card } : {}) }),
      answerApproval: (_s: string, requestId: string, answer: unknown, origin: string) => { answered.push({ requestId, answer, origin }); return answerResult; },
    } as unknown as ChatControl;
    return { control, answered, clear: () => { card = undefined; } };
  }
  const bash = (command: string): LiveApprovalCard => ({ requestId: "r1", tool: "Bash", input: { command }, isQuestion: false });
  const args = (extra: Record<string, unknown> = {}) => ({ project: "api", sessionId: SESSION, requestId: "r1", decision: "allow", ...extra });

  it("repeats the command verbatim on its confirmation, then answers once approved", async () => {
    const f = fakeControl(bash("echo x > ~/.bashrc"));
    const { ask, asked } = asker(APPROVE);
    const result = await chatAnswerApproval(args(), ask, { control: f.control, title: () => "Fix login" });
    expect(JSON.parse(text(result))).toMatchObject({ answered: true, decision: "allow", requestId: "r1" });
    const card = asked[0]!.summary;
    // Plain text: what the card shows is exactly what the chat would run.
    expect(card.body).toEqual({ label: "Command", text: "echo x > ~/.bashrc", format: "text" });
    expect(card.facts).toContainEqual({ label: "Your answer", value: "Allow", tone: "warning" });
    expect(f.answered).toEqual([{ requestId: "r1", answer: { approved: true }, origin: "assistant" }]);
  });

  it("asks before denying too, and answers nothing when the user declines the confirmation", async () => {
    const f = fakeControl(bash("rm -rf build"));
    const { ask, asked } = asker(DENY);
    expect((await chatAnswerApproval(args({ decision: "deny" }), ask, { control: f.control, title: () => null })).isError).toBe(true);
    expect(asked[0]!.summary.facts).toContainEqual({ label: "Your answer", value: "Deny" });
    expect(f.answered).toHaveLength(0);
  });

  it("never answers a card that moved on: another card, answered meanwhile, or stale", async () => {
    const other = fakeControl({ ...bash("ls"), requestId: "r2" });
    const { ask, asked } = asker(APPROVE);
    expect(text(await chatAnswerApproval(args(), ask, { control: other.control }))).toContain("now shows card r2");
    expect(asked).toHaveLength(0);

    const meanwhile = fakeControl(bash("ls"));
    const r = await chatAnswerApproval(args(), asker(APPROVE, meanwhile.clear).ask, { control: meanwhile.control, title: () => null });
    expect(text(r)).toContain("already answered elsewhere");
    expect(meanwhile.answered).toHaveLength(0);

    const stale = fakeControl(bash("ls"), "stale");
    expect(text(await chatAnswerApproval(args(), asker(APPROVE).ask, { control: stale.control, title: () => null }))).toContain("already answered elsewhere");
  });

  it("will not allow what it cannot show in full, but can deny it", async () => {
    const patch: LiveApprovalCard = { requestId: "r1", tool: "Edit", input: approvalInput("item/fileChange/requestApproval", { reason: "fix" }), isQuestion: false };
    const f = fakeControl(patch);
    const { ask, asked } = asker(APPROVE);
    expect(text(await chatAnswerApproval(args(), ask, { control: f.control }))).toContain("cannot be shown in full");
    expect(asked).toHaveLength(0);
    expect(JSON.parse(text(await chatAnswerApproval(args({ decision: "deny" }), ask, { control: f.control, title: () => null })))).toMatchObject({ answered: true });
  });

  it("answers a question by id after checking every answer, and leaves secrets to the chat", async () => {
    const questions = normalizeCodexQuestions({ questions: [{ id: "env", question: "Deploy where?", isOther: false, options: [{ label: "staging" }, { label: "prod" }] }] });
    const card: LiveApprovalCard = { requestId: "r1", tool: "AskUserQuestion", input: { questions }, isQuestion: true, questions };
    const f = fakeControl(card);
    const { ask, asked } = asker(APPROVE);
    expect(text(await chatAnswerApproval(args({ answersById: { env: ["live"] } }), ask, { control: f.control }))).toContain("not an option");
    expect(asked).toHaveLength(0);
    const ok = await chatAnswerApproval(args({ answersById: { env: ["prod"] } }), ask, { control: f.control, title: () => null });
    expect(JSON.parse(text(ok))).toMatchObject({ answered: true, answers: { "Deploy where?": "prod" } });
    expect(asked[0]!.summary.facts).toContainEqual({ label: "Deploy where?", value: "prod" });
    expect(f.answered[0]!.answer).toEqual({ approved: true, answersById: { env: ["prod"] } });

    const secret = normalizeCodexQuestions({ questions: [{ id: "t", question: "Token?", isSecret: true, options: null }] });
    const s = fakeControl({ requestId: "r1", tool: "AskUserQuestion", input: { questions: secret }, isQuestion: true, questions: secret });
    expect(text(await chatAnswerApproval(args({ answersById: { t: ["x"] } }), ask, { control: s.control }))).toContain("secret");
  });
});
