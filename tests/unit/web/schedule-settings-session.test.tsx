/**
 * Settings → Schedules for a chat schedule: the row names its chat (and opens it), offers Resume
 * where PPM paused it, and the form shows only the fields such a schedule has and prints the
 * server's refusals in place.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, installGlobal, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import type { ScheduleView } from "../../../src/types/scheduler";

installDom();
// Radix dialogs watch their content with an observer.
installGlobal("MutationObserver", window.MutationObserver);
// Radix selects build their closed list into one.
installGlobal("DocumentFragment", window.DocumentFragment);
afterAll(uninstallDom);
const { ScheduleSessionTarget } = await import("../../../src/web/components/settings/schedules/schedule-session-target");
const { ScheduleForm } = await import("../../../src/web/components/settings/schedules/schedule-form");
const { api, ApiError } = await import("../../../src/web/lib/api-client");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { useTabStore } = await import("../../../src/web/stores/tab-store");
const { act } = await import("react");

const CHAT = "aaaaaaaa-0000-4000-8000-000000000001";
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const schedule = (over: Partial<ScheduleView> = {}): ScheduleView => ({
  id: 4, name: "Nightly check", cron_expr: "0 22 * * *", provider_id: "claude", project_path: "/work/ppm", prompt: "Run the checks",
  permission_mode: "default", max_turns: null, timeout_ms: 1_800_000, enabled: 1, session_id: null, last_run_at: null,
  next_fire_at: "2026-11-15T15:00:00.000Z", created_at: "", updated_at: "", kind: "session", mode: "tick", description: "",
  script: null, target_session_id: CHAT, timezone: "Asia/Saigon", recurring: 1, pending_since: null, paused_reason: null,
  inputs: [], inputValues: {}, secretsSet: [],
  status: { state: "idle", pid: null, since: null, restartAt: null, restarts: 0, lastError: null },
  target_title: "Release chat",
  ...over,
});

let view: Mounted | null = null;
let get: ReturnType<typeof spyOn>;
let patch: ReturnType<typeof spyOn>;

beforeEach(() => {
  useProjectStore.setState({ projects: [{ name: "ppm", path: "/work/ppm" }] as never, activeProject: { name: "ppm", path: "/work/ppm" } as never });
  get = spyOn(api, "get").mockImplementation(((path: string) => Promise.resolve(
    path === "/api/projects" ? [{ name: "ppm", path: "/work/ppm" }]
      : path.includes("/chat/sessions") ? { sessions: [{ id: CHAT, providerId: "claude", title: "Release chat", createdAt: "" }], hasMore: false }
      : null,
  )) as never);
  patch = spyOn(api, "patch").mockImplementation((() => Promise.resolve({})) as never);
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  get.mockRestore();
  patch.mockRestore();
});

describe("a chat schedule's row in Settings", () => {
  it("names its chat and opens it when tapped", async () => {
    const openTab = spyOn(useTabStore.getState(), "openTab").mockImplementation(() => "tab");
    try {
      view = await mount(<ScheduleSessionTarget schedule={schedule()} onChanged={() => {}} />);
      const link = view.container.querySelector<HTMLButtonElement>(`[data-schedule-target="${CHAT}"] button`)!;
      expect(link.textContent).toContain("Session");
      expect(link.textContent).toContain("Release chat");
      expect(link.className).toContain("min-h-11");
      await click(link);
      expect(openTab.mock.calls[0]![0]).toMatchObject({ type: "chat", metadata: { sessionId: CHAT, providerId: "claude", projectName: "ppm" } });
    } finally {
      openTab.mockRestore();
    }
  });

  it("says why PPM paused it and resumes it in place", async () => {
    let changed = 0;
    view = await mount(<ScheduleSessionTarget schedule={schedule({ enabled: 0, paused_reason: "The chat was deleted." })} onChanged={() => { changed++; }} />);
    expect(view.container.textContent).toContain("The chat was deleted.");
    await click(view.container.querySelector('[data-testid="schedule-resume"]'));
    expect(patch.mock.calls[0]).toEqual(["/api/schedules/4", { enabled: true }]);
    expect(changed).toBe(1);
  });

  it("says when it is waiting for its chat, with no Resume", async () => {
    view = await mount(<ScheduleSessionTarget schedule={schedule({ pending_since: "2026-11-15T08:00:00.000Z" })} onChanged={() => {}} />);
    expect(view.container.textContent).toContain("sent once the chat is idle");
    expect(view.container.querySelector('[data-testid="schedule-resume"]')).toBeNull();
  });
});

describe("the form for a chat schedule", () => {
  const text = () => document.body.textContent ?? "";
  const save = () => [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Save changes")!;

  it("shows its chat, time zone and Run once, and none of a prompt schedule's run settings", async () => {
    view = await mount(<ScheduleForm open schedule={schedule()} onClose={() => {}} onSaved={() => {}} />);
    await flush();
    expect(text()).toContain("Chat");
    expect(text()).toContain("Time zone");
    expect(text()).toContain("Run once");
    expect(text()).not.toContain("Permission mode");
    expect(text()).not.toContain("Max turns");
    expect(text()).not.toContain("Timeout");
  });

  it("prints the server's problems and its per-chat cap in place", async () => {
    patch.mockImplementation((() => Promise.reject(new ApiError("Bad", 400, { error: "Bad", problems: ["timezone must be an IANA time zone such as Europe/London"] }))) as never);
    view = await mount(<ScheduleForm open schedule={schedule()} onClose={() => {}} onSaved={() => {}} />);
    await flush();
    await click(save());
    await flush();
    expect(text()).toContain("timezone must be an IANA time zone such as Europe/London");

    patch.mockImplementation((() => Promise.reject(new ApiError("This chat already has 20 schedules", 409, { error: "This chat already has 20 schedules", code: "limit" }))) as never);
    await click(save());
    await flush();
    expect(text()).toContain("This chat already has 20 schedules");
  });
});
