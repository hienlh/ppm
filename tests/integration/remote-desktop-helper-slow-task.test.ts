/**
 * A helper task slower than Bun.serve's 10-second idle limit still gets its answer to the caller.
 *
 * Found on a real host: a Reattach whose PowerShell took 20 s to start. Bun cut the request at
 * 10 s ("Bun.serve() timed out a request after 10 seconds"), so the page reported a failure while
 * tscon went on to move the session anyway. Driven through a real `Bun.serve` with its default
 * timeout, because `app.request()` has no server and no timeout at all. The pretend Windows
 * answers on a real clock, 16 s after the task is started.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { remoteDesktopRoutes } from "../../src/server/routes/remote-desktop.ts";
import { configService } from "../../src/services/config.service.ts";
import { setHelperSystem } from "../../src/services/remote-desktop/win32-helper/helper-system.ts";
import { resetHelperServiceForTests } from "../../src/services/remote-desktop/win32-helper/helper-service.ts";
import { HELPER_ACTIONS, helperPaths, HELPER_VERSION, taskName } from "../../src/services/remote-desktop/win32-helper/helper-paths.ts";
import { createFakeWindows, FAKE_SID, type FakeWindows } from "../helpers/fake-windows-helper-system.ts";

// Bun checks its idle timeout on a coarse tick: measured here, a request is cut anywhere between
// about 8 and 14 seconds. 16 s is past that on every run, and inside the helper's 20 s wait.
const SLOW_MS = 16_000;
const originalFlag = process.env.REMOTE_DESKTOP_ENABLED;
let server: ReturnType<typeof Bun.serve>;
let win: FakeWindows;
const spies: Array<{ mockRestore(): void }> = [];

beforeAll(() => {
  // Default idleTimeout (10 s): the limit the real server runs with.
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, s) => remoteDesktopRoutes.fetch(req, s) });
});
afterAll(() => { server.stop(true); });

beforeEach(() => {
  process.env.REMOTE_DESKTOP_ENABLED = "1";
  spies.push(spyOn(configService, "get").mockReturnValue({ enabled: true } as never));
  win = createFakeWindows();
  // A real clock: the helper's answer has to arrive in real time, after Bun's limit.
  win.now = () => Date.now();
  win.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const p = helperPaths();
  win.files.set(p.helperScript, "# helper");
  win.files.set(p.installRecord, JSON.stringify({ version: HELPER_VERSION, userSid: FAKE_SID, actions: [...HELPER_ACTIONS] }));
  for (const action of HELPER_ACTIONS) win.tasks.add(taskName(action));
  win.onTaskRun = (task) => {
    const action = task.split("\\").pop();
    setTimeout(() => {
      win.files.set(p.lastRun, JSON.stringify({ action, ok: true, message: `${action} done slowly`, at: new Date().toISOString() }));
    }, SLOW_MS);
  };
  setHelperSystem(win);
  resetHelperServiceForTests();
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  setHelperSystem(null);
  resetHelperServiceForTests();
  if (originalFlag === undefined) delete process.env.REMOTE_DESKTOP_ENABLED;
  else process.env.REMOTE_DESKTOP_ENABLED = originalFlag;
});

async function post(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: { connection: "close" } });
  return { status: res.status, body: await res.json() };
}

describe("a helper task slower than Bun's 10-second limit", () => {
  it("Bring session back still answers with the helper's result", async () => {
    const started = Date.now();
    const r = await post("/requirements/win-session/reattach");
    expect(Date.now() - started).toBeGreaterThan(10_000);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ data: { ok: true, message: "Reattach done slowly" } });
  }, 45_000);

  it("I can still reach this PC still answers with the helper's result", async () => {
    const r = await post("/headless-helper/confirm");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ data: { ok: true, message: "Confirm done slowly" } });
  }, 45_000);
});
