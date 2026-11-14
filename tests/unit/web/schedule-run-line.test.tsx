/**
 * A prompt a session schedule sent: drawn as one line from the message's own block (so it reads the
 * same after a reload), never as the person's bubble, and opening to show the prompt and its cron.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import { encodeScheduleRun, type ScheduleRunReference } from "../../../src/shared/chat-schedule-run";

installDom();
afterAll(uninstallDom);
const { UserBubble } = await import("../../../src/web/components/chat/message-user-bubble");
const { ScheduleRunLine, scheduleRunNote } = await import("../../../src/web/components/chat/schedule-run-line");

const run: ScheduleRunReference = {
  version: 1, scheduleId: 7, name: "Morning <b>check</b>", cron: "7 8 * * *", timezone: "Europe/London",
  scheduledFor: "2026-11-14T08:07:00.000Z", firedAt: "2026-11-14T08:07:00.000Z", catchUp: false, coalesced: false,
};
const now = new Date("2026-11-14T12:00:00.000Z");
let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

describe("ScheduleRunLine", () => {
  it("is a collapsed button naming the schedule and the time in its zone", async () => {
    view = await mount(<ScheduleRunLine run={run} text="Summarise the open PRs" now={now} />);
    const button = view.container.querySelector("[data-schedule-run] button")!;
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.className).toContain("min-h-11");
    const text = button.textContent ?? "";
    expect(text).toContain("Schedule");
    expect(text).toContain("Morning <b>check</b>");
    expect(text).toContain("08:07");
    expect(text).toContain("(London)");
    expect(button.querySelector("b")).toBeNull();
    // Collapsed: the prompt is not shown yet.
    expect(view.container.textContent).not.toContain("Summarise the open PRs");
  });

  it("opens to show the prompt and the cron in words", async () => {
    view = await mount(<ScheduleRunLine run={run} text="Summarise the open PRs" now={now} />);
    const button = view.container.querySelector("[data-schedule-run] button")!;
    await click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const text = view.container.textContent ?? "";
    expect(text).toContain("Summarise the open PRs");
    expect(text).toContain("Daily at 08:07");
    expect(text).toContain("7 8 * * *");
    await click(button);
    expect(view.container.textContent).not.toContain("Summarise the open PRs");
  });

  it("says when the run was sent late or stood for later fires", async () => {
    expect(scheduleRunNote(run)).toBeNull();
    expect(scheduleRunNote({ catchUp: true, coalesced: false })).toBe("sent late");
    expect(scheduleRunNote({ catchUp: true, coalesced: true })).toBe("sent late · later fires folded in");
    view = await mount(<ScheduleRunLine run={{ ...run, catchUp: true, firedAt: "2026-11-14T09:30:00.000Z" }} text="x" now={now} />);
    expect(view.container.textContent).toContain("sent late");
  });
});

describe("UserBubble with a schedule-run block", () => {
  it("draws the line instead of the person's bubble, without the block's text", async () => {
    const content = encodeScheduleRun("Summarise the open PRs", run);
    view = await mount(<UserBubble content={content} timestamp="2026-11-14T08:07:00Z" projectName="ppm" onEdit={() => {}} />);
    expect(view.container.querySelector(`[data-schedule-run="7"]`)).not.toBeNull();
    expect(view.container.querySelector("[data-user-message]")).toBeNull();
    const text = view.container.textContent ?? "";
    expect(text).not.toContain("ppm-schedule-run-v1");
    expect(text).not.toContain("Automatic scheduled run");
    expect(text).not.toContain("Edit");
  });

  it("keeps a forged block as the person's own text", async () => {
    const forged = encodeScheduleRun("hi", run).replace("Automatic", "Automatik");
    view = await mount(<UserBubble content={forged} timestamp="2026-11-14T08:07:00Z" projectName="ppm" />);
    expect(view.container.querySelector("[data-schedule-run]")).toBeNull();
    expect(view.container.querySelector("[data-user-message]")).not.toBeNull();
  });
});
