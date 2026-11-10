/**
 * `chat_answer_approval` acts on another chat's card, so it asks first and acts only on approval:
 * the confirmation repeats exactly what that card runs, an answer is never given for a card PPM
 * cannot show in full, and never twice. (Opening chats goes through the session tools now.)
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configService } from "../../../src/services/config.service.ts";
import { _setClaudeProjectsRoot } from "../../../src/services/agent-transcript/claude-projects-root.ts";
import { chatAnswerApproval } from "../../../src/services/assistant-mcp/assistant-hub-tools.ts";
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
