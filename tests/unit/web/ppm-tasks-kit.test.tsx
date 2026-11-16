/**
 * The PPM Tasks UI kit: what the working-session chip says in every state (a check finding wins
 * over the live dot, Start chat when nobody works on it, one tap opens the chat), the urgency
 * pill's "auto" mark, the due label, link states, and the rest rendered from props alone.
 */
import { afterEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { click, mount, type Mounted } from "../../helpers/react-dom.tsx";
import { dueView, linkStateView, memberInitials, memberTone, sessionChipView } from "../../../src/web/lib/ppm-tasks/ppm-tasks-kit-logic.ts";
import type { TaskSessionState, TaskWorkingSession } from "../../../src/shared/ppm-tasks-api.ts";

const { TaskWorkingSessionChip } = await import("../../../src/web/components/ppm-tasks/kit/task-working-session-chip");
const { TaskUrgencyPill } = await import("../../../src/web/components/ppm-tasks/kit/task-urgency-pill");
const { TaskStatusGlyph } = await import("../../../src/web/components/ppm-tasks/kit/task-status-glyph");
const { TaskImportanceBars } = await import("../../../src/web/components/ppm-tasks/kit/task-importance-bars");
const { TaskTypeBadge } = await import("../../../src/web/components/ppm-tasks/kit/task-type-badge");
const { TaskDueLabel } = await import("../../../src/web/components/ppm-tasks/kit/task-due-label");
const { TaskLinkStatePill } = await import("../../../src/web/components/ppm-tasks/kit/task-link-state-pill");
const { TaskResultBlock } = await import("../../../src/web/components/ppm-tasks/kit/task-result-block");
const { TaskUnattendedBadge } = await import("../../../src/web/components/ppm-tasks/kit/task-unattended-badge");
const { TaskMemberAvatar } = await import("../../../src/web/components/ppm-tasks/kit/task-member-avatar");

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const session = (over: Partial<TaskSessionState> = {}): TaskSessionState => ({ sessionId: "c1", state: "idle", title: "Login fix", ...over });
const child = (over: Partial<TaskSessionState> = {}): TaskWorkingSession => ({ kind: "session", session: session(over) });

let mounted: Mounted | null = null;
afterEach(async () => { await mounted?.unmount(); mounted = null; });

describe("working-session chip", () => {
  it("says what the chat is doing, a check finding first", () => {
    expect(sessionChipView(child({ state: "running" }), null, NOW)).toMatchObject({ tone: "run", label: "Login fix", detail: null });
    expect(sessionChipView(child({ state: "waiting_card" }), null, NOW)).toMatchObject({ tone: "need", detail: "waiting on you" });
    expect(sessionChipView(child({ state: "running" }), { state: "stalled", since: NOW - 40 * MIN, lastProgressAt: NOW - 40 * MIN }, NOW))
      .toMatchObject({ tone: "stalled", detail: "stalled 40 min" });
    expect(sessionChipView(child(), { state: "finished_no_report", since: NOW - MIN, lastProgressAt: null }, NOW))
      .toMatchObject({ tone: "finished", detail: "finished, no report" });
    expect(sessionChipView(child(), { state: "running", since: NOW, lastProgressAt: NOW }, NOW).tone).toBe("idle");
    expect(sessionChipView(child({ state: "gone" }), null, NOW)).toMatchObject({ tone: "gone", detail: "deleted" });
    expect(sessionChipView({ kind: "manager", label: "Manager", session: session({ state: "running", title: "QL" }) }, null, NOW))
      .toMatchObject({ tone: "mgr", label: "Manager", sessionId: "c1" });
    expect(sessionChipView({ kind: "start_chat" }, null, NOW)).toMatchObject({ tone: "none", label: "Start chat", sessionId: null });
  });

  it("opens the chat on tap, or starts one when nobody works on the task", async () => {
    const opened: string[] = [];
    let started = 0;
    mounted = await mount(
      <div>
        <TaskWorkingSessionChip working={child({ state: "running" })} check={{ state: "stalled", since: NOW - 12 * MIN, lastProgressAt: null }} now={NOW} onOpen={(id) => opened.push(id)} />
        <TaskWorkingSessionChip working={{ kind: "start_chat" }} onStartChat={() => { started++; }} />
      </div>,
    );
    const [chip, start] = [...mounted.container.querySelectorAll("button")];
    expect(chip!.getAttribute("data-session-tone")).toBe("stalled");
    expect(chip!.textContent).toContain("stalled 12 min");
    await click(chip!);
    await click(start!);
    expect(opened).toEqual(["c1"]);
    expect(started).toBe(1);
    expect(start!.textContent).toContain("Start chat");
  });

  it("cannot open a deleted chat", async () => {
    mounted = await mount(<TaskWorkingSessionChip working={child({ state: "gone" })} onOpen={() => {}} />);
    expect(mounted.container.querySelector("button")!.disabled).toBe(true);
  });
});

describe("urgency, status, importance, type", () => {
  it("marks an urgency the due date raised", async () => {
    mounted = await mount(<div><TaskUrgencyPill urgency="now" raised /><TaskUrgencyPill urgency="week" /></div>);
    const [raised, plain] = [...mounted.container.querySelectorAll("[data-urgency]")];
    expect(raised!.textContent).toBe("Now");
    expect(raised!.getAttribute("data-raised")).toBe("auto");
    expect(raised!.querySelector("svg")).not.toBeNull();
    expect(plain!.textContent).toBe("This week");
    expect(plain!.getAttribute("data-raised")).toBeNull();
  });

  it("draws status by base group, dropped apart from done", async () => {
    mounted = await mount(
      <div>
        <TaskStatusGlyph baseGroup="closed" closedAs="dropped" name="Dropped" showName />
        <TaskStatusGlyph baseGroup="closed" closedAs="done" name="Done" />
        <TaskStatusGlyph baseGroup="waiting" closedAs={null} name="Waiting" />
        <TaskImportanceBars importance="should" />
        <TaskTypeBadge type="decision" />
        <TaskTypeBadge type="reply" tile />
      </div>,
    );
    const glyphs = [...mounted.container.querySelectorAll("[data-status-glyph]")].map((g) => g.getAttribute("data-status-glyph"));
    expect(glyphs).toEqual(["drop", "done", "wait"]);
    expect(mounted.container.textContent).toContain("Dropped");
    expect(mounted.container.querySelectorAll("[data-importance] i[data-filled]")).toHaveLength(2);
    expect(mounted.container.textContent).toContain("Should");
    expect(mounted.container.textContent).toContain("Decision");
    expect(mounted.container.querySelector("[data-task-type='reply']")!.getAttribute("aria-label")).toBe("Reply");
  });
});

describe("due, people, links, result", () => {
  it("words the due date", () => {
    expect(dueView("2026-11-14", "2026-11-16")).toEqual({ label: "Overdue 2d", soon: true, overdue: true });
    expect(dueView("2026-11-16", "2026-11-16")?.label).toBe("Today");
    expect(dueView("2026-11-17", "2026-11-16")).toEqual({ label: "Tomorrow", soon: true, overdue: false });
    expect(dueView("2026-11-20", "2026-11-16")?.label).toBe("Fri");
    expect(dueView("2026-12-01", "2026-11-16")?.label).toBe("1 Dec");
    expect(dueView(null, "2026-11-16")).toBeNull();
  });

  it("renders the due label red when soon", async () => {
    mounted = await mount(<TaskDueLabel dueDate="2026-11-17" today="2026-11-16" />);
    expect(mounted.container.querySelector("[data-due]")!.getAttribute("data-due")).toBe("soon");
  });

  it("gives members stable initials and tones", async () => {
    expect(memberInitials("Linh Tran Thi")).toBe("LT");
    expect(memberInitials("bao")).toBe("BA");
    expect(memberTone("m-1")).toBe(memberTone("m-1"));
    mounted = await mount(<TaskMemberAvatar name="Linh Tran" memberId="m-1" showName />);
    expect(mounted.container.textContent).toBe("LTLinh Tran");
  });

  it("reads link states, saying when a state could not be read", async () => {
    const pr = { kind: "pr" as const, ref: "acme/web#412", label: null };
    expect(linkStateView(pr, { kind: "pr", ref: pr.ref, state: { state: "open", checks: { failing: 2, pending: 0 } }, error: null, checkedAt: 1, changedAt: 1 }))
      .toEqual({ key: "web#412", state: "open · CI failing", tone: "bad" });
    expect(linkStateView(pr, { kind: "pr", ref: pr.ref, state: null, error: "gh not available", checkedAt: 1, changedAt: null }))
      .toEqual({ key: "web#412", state: "state unknown · gh not available", tone: "idle" });
    const jira = { kind: "jira" as const, ref: "NX-6318", label: null };
    expect(linkStateView(jira, { kind: "jira", ref: jira.ref, state: { status: "In Review", category: "indeterminate" }, error: null, checkedAt: 1, changedAt: 1 }))
      .toEqual({ key: "NX-6318", state: "In Review", tone: "info" });
    expect(linkStateView({ kind: "url", ref: "https://example.com/a", label: null }, null)).toEqual({ key: "example.com", state: null, tone: "idle" });
    const opened: string[] = [];
    mounted = await mount(<TaskLinkStatePill link={jira} state={null} onOpen={(l) => opened.push(l.ref)} />);
    await click(mounted.container.querySelector("button"));
    expect(opened).toEqual(["NX-6318"]);
  });

  it("shows a result only when there is one, and the away badge", async () => {
    mounted = await mount(<div><TaskResultBlock result={null} /><TaskResultBlock result={{ text: "Merged #412", at: NOW, by: "Manager ppm" }} /><TaskUnattendedBadge /></div>);
    expect(mounted.container.querySelectorAll("[data-task-result]")).toHaveLength(1);
    expect(mounted.container.textContent).toContain("Merged #412");
    expect(mounted.container.textContent).toContain("Manager ppm");
    expect(mounted.container.textContent).toContain("while you were away");
  });
});
