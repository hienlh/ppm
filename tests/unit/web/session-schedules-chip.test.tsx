/**
 * The schedules chip in the chat footer: absent with none, counting them, marked when one needs a
 * look, re-reading on `schedules:changed`, and its Pause/Resume and Delete reaching the right routes.
 *
 * Classes rather than pixels for the touch targets: happy-dom does no layout.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import type { ScheduleView } from "../../../src/types/scheduler";

installDom();
afterAll(uninstallDom);
const { SessionSchedulesChip } = await import("../../../src/web/components/chat/session-schedules-chip");
const { api } = await import("../../../src/web/lib/api-client");
const { act } = await import("react");

/** Let the fetch the chip started settle and render. */
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const SESSION = "aaaaaaaa-0000-4000-8000-000000000001";

function schedule(over: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id: 1, name: "Morning check", cron_expr: "0 8 * * *", provider_id: "claude", project_path: "/p", prompt: "Check PRs",
    permission_mode: "default", max_turns: null, timeout_ms: 1_800_000, enabled: 1, session_id: null, last_run_at: null,
    next_fire_at: "2026-11-16T08:00:00.000Z", created_at: "", updated_at: "", kind: "session", mode: "tick", description: "",
    script: null, target_session_id: SESSION, timezone: "Europe/London", recurring: 1, pending_since: null, paused_reason: null,
    inputs: [], inputValues: {}, secretsSet: [],
    status: { state: "idle", pid: null, since: null, restartAt: null, restarts: 0, lastError: null },
    target_title: "My chat",
    ...over,
  };
}

let view: Mounted | null = null;
let rows: ScheduleView[] = [];
let get: ReturnType<typeof spyOn>;
let patch: ReturnType<typeof spyOn>;
let del: ReturnType<typeof spyOn>;

beforeEach(() => {
  rows = [];
  get = spyOn(api, "get").mockImplementation((() => Promise.resolve(rows)) as never);
  patch = spyOn(api, "patch").mockImplementation((() => Promise.resolve({})) as never);
  del = spyOn(api, "del").mockImplementation((() => Promise.resolve()) as never);
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  get.mockRestore();
  patch.mockRestore();
  del.mockRestore();
});

const chip = () => view!.container.querySelector('[data-testid="session-schedules-chip"]');
const button = (id: string) => view!.container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;

async function render() {
  view = await mount(<SessionSchedulesChip sessionId={SESSION} />);
  await flush();
}

describe("session schedules chip", () => {
  it("asks for this chat's schedules and is absent while it has none", async () => {
    await render();
    expect(get.mock.calls[0]![0]).toBe(`/api/schedules?session=${SESSION}`);
    expect(chip()).toBeNull();
  });

  it("counts the schedules, and appears when one is added elsewhere", async () => {
    await render();
    expect(chip()).toBeNull();
    rows = [schedule(), schedule({ id: 2, name: "Weekly" })];
    window.dispatchEvent(new window.Event("schedules:changed"));
    await flush();
    expect(chip()!.textContent).toContain("2");
    expect(chip()!.getAttribute("data-attention")).toBeNull();
  });

  it("is marked when a schedule is paused or waiting for the chat", async () => {
    rows = [schedule(), schedule({ id: 2, enabled: 0, paused_reason: "The chat was deleted." })];
    await render();
    expect(chip()!.getAttribute("data-attention")).toBe("true");
    expect(chip()!.className).toContain("text-warning");
  });

  it("lists each schedule with its next run, how often, and its state", async () => {
    rows = [schedule({ recurring: 0, pending_since: "2026-11-15T08:00:00.000Z" })];
    await render();
    await click(chip());
    const item = view!.container.querySelector('[data-session-schedule="1"]')!;
    const text = item.textContent ?? "";
    expect(text).toContain("Morning check");
    expect(text).toContain("Daily at 08:00");
    expect(text).toContain("Runs once");
    expect(text).toContain("Waiting for the chat");
    expect(text).toContain("(London)");
  });

  it("pauses an active schedule and resumes a paused one", async () => {
    rows = [schedule()];
    await render();
    await click(chip());
    expect(button("session-schedule-toggle").textContent).toContain("Pause");
    await click(button("session-schedule-toggle"));
    expect(patch.mock.calls[0]).toEqual(["/api/schedules/1", { enabled: false }]);
    await view!.unmount();

    rows = [schedule({ enabled: 0, paused_reason: "PPM could not send it." })];
    await render();
    await click(chip());
    expect(view!.container.textContent).toContain("PPM could not send it.");
    expect(button("session-schedule-toggle").textContent).toContain("Resume");
    await click(button("session-schedule-toggle"));
    expect(patch.mock.calls[1]).toEqual(["/api/schedules/1", { enabled: true }]);
  });

  it("deletes only after a second press, with touch-sized buttons on a phone", async () => {
    rows = [schedule()];
    await render();
    await click(chip());
    expect(button("session-schedule-delete").className).toContain("max-md:h-11");
    await click(button("session-schedule-delete"));
    expect(del).not.toHaveBeenCalled();
    await click(button("session-schedule-confirm-delete"));
    expect(del.mock.calls[0]![0]).toBe("/api/schedules/1");
  });
});
