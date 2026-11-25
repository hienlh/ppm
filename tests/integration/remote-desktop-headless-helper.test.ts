/**
 * The Windows headless helper end to end through PPM's routes, against a pretend Windows
 * (`fake-windows-helper-system.ts`): install through one elevated launch, bring the session
 * back through a fixed task, and the guards in front of both. No real task, UAC or tscon.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { remoteDesktopRoutes } from "../../src/server/routes/remote-desktop.ts";
import { configService } from "../../src/services/config.service.ts";
import { setHelperSystem } from "../../src/services/remote-desktop/win32-helper/helper-system.ts";
import { resetHelperServiceForTests } from "../../src/services/remote-desktop/win32-helper/helper-service.ts";
import { helperPaths, HELPER_VERSION, taskName } from "../../src/services/remote-desktop/win32-helper/helper-paths.ts";
import { bootstrapOf, createFakeWindows, FAKE_SID, type FakeWindows } from "../helpers/fake-windows-helper-system.ts";

const originalFlag = process.env.REMOTE_DESKTOP_ENABLED;
const spies: Array<{ mockRestore(): void }> = [];
let win: FakeWindows;

function auth(enabled: boolean) {
  spies.push(spyOn(configService, "get").mockReturnValue({ enabled } as never));
}

/** What a successful elevated install leaves on the pretend disk. */
function markInstalled(sid = FAKE_SID, version = HELPER_VERSION) {
  const p = helperPaths();
  win.files.set(p.helperScript, "# helper");
  win.files.set(p.installRecord, JSON.stringify({ version, userSid: sid, actions: ["Reattach"] }));
  win.tasks.add(taskName("Reattach"));
}

async function waitForJob(): Promise<{ state: string; message: string | null }> {
  for (let i = 0; i < 50; i++) {
    const r = await remoteDesktopRoutes.request("http://localhost/headless-helper");
    const job = (await r.json() as { data: { job: { state: string; message: string | null } } }).data.job;
    if (job && job.state !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("job never finished");
}

beforeEach(() => {
  process.env.REMOTE_DESKTOP_ENABLED = "1";
  win = createFakeWindows();
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

describe("headless helper routes: guards", () => {
  it("refuses status, install and the reattach action without PPM auth", async () => {
    auth(false);
    expect((await remoteDesktopRoutes.request("http://localhost/headless-helper")).status).toBe(403);
    expect((await remoteDesktopRoutes.request("http://localhost/headless-helper/install", { method: "POST" })).status).toBe(403);
    expect((await remoteDesktopRoutes.request("http://localhost/requirements/win-session/reattach", { method: "POST" })).status).toBe(403);
    expect(win.calls).toEqual([]);
  });

  it("refuses a cross-origin request before running anything", async () => {
    auth(true);
    const res = await remoteDesktopRoutes.request("http://localhost/requirements/win-session/reattach", {
      method: "POST", headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(win.calls).toEqual([]);
  });

  it("knows only its own action names", async () => {
    auth(true);
    expect((await remoteDesktopRoutes.request("http://localhost/headless-helper/run-anything", { method: "POST" })).status).toBe(404);
    expect((await remoteDesktopRoutes.request("http://localhost/requirements/win-session/tscon", { method: "POST" })).status).toBe(404);
    expect((await remoteDesktopRoutes.request("http://localhost/requirements/ffmpeg/reattach", { method: "POST" })).status).toBe(404);
    expect(win.calls).toEqual([]);
  });
});

describe("headless helper: install", () => {
  it("stages the scripts, elevates once, and verifies them by hash in the bootstrap", async () => {
    auth(true);
    win.elevationExit = 0;
    const res = await remoteDesktopRoutes.request("http://localhost/headless-helper/install", { method: "POST" });
    expect(res.status).toBe(202);
    const job = await waitForJob();
    expect(job.state).toBe("done");

    const staged = helperPaths().stagingDir;
    const helper = [...win.files.entries()].find(([k]) => k.startsWith(staged) && k.endsWith("helper.ps1"))?.[1];
    expect(helper).toContain(`$UserSid = '${FAKE_SID}'`);
    const boot = bootstrapOf(win.lastLauncher ?? "");
    const helperHash = createHash("sha256").update(Buffer.from(helper!, "utf8")).digest("hex");
    expect(boot).toContain(`'${helperHash}'`);
    expect(win.lastLauncher).toContain("-Verb RunAs");
    // One elevation, by absolute path.
    const launches = win.calls.filter((c) => c[0]!.toLowerCase().endsWith("powershell.exe"));
    expect(launches).toHaveLength(1);
    expect(launches[0]![0]).toMatch(/System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  });

  it("says plainly when the administrator prompt was declined or could not be shown", async () => {
    auth(true);
    win.elevationExit = 1223;
    await remoteDesktopRoutes.request("http://localhost/headless-helper/install", { method: "POST" });
    const job = await waitForJob();
    expect(job.state).toBe("error");
    expect(job.message).toContain("declined");
  });

  it("reports a staged file that changed before the admin step read it", async () => {
    auth(true);
    win.elevationExit = 10;
    await remoteDesktopRoutes.request("http://localhost/headless-helper/install", { method: "POST" });
    expect((await waitForJob()).message).toContain("changed");
  });
});

describe("headless helper: status", () => {
  async function status() {
    const r = await remoteDesktopRoutes.request("http://localhost/headless-helper");
    return (await r.json() as { data: Record<string, unknown> }).data;
  }

  it("is usable only when installed for this user, current, with its task present", async () => {
    auth(true);
    expect(await status()).toMatchObject({ supported: true, installed: false, usable: false });
    resetHelperServiceForTests();
    markInstalled();
    expect(await status()).toMatchObject({ installed: true, usable: true });
  });

  it("does not let another Windows user's install be used", async () => {
    auth(true);
    markInstalled("S-1-5-21-9-9-9-500");
    expect(await status()).toMatchObject({ installed: true, otherUser: true, usable: false });
  });

  it("asks for a reinstall after an update changes the scripts", async () => {
    auth(true);
    markInstalled(FAKE_SID, HELPER_VERSION - 1);
    expect(await status()).toMatchObject({ outdated: true, usable: false });
  });
});

describe("headless helper: bring the session back", () => {
  it("runs exactly the fixed task, passing nothing, and returns the helper's own answer", async () => {
    auth(true);
    markInstalled();
    win.onTaskRun = () => {
      win.files.set(helperPaths().lastRun, JSON.stringify({ action: "Reattach", ok: true, message: "Session 2 is back on the PC screen.", at: new Date(win.now()).toISOString() }));
    };
    const res = await remoteDesktopRoutes.request("http://localhost/requirements/win-session/reattach", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { ok: true, message: "Session 2 is back on the PC screen." } });
    const runs = win.calls.filter((c) => c[1] === "/run");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.slice(1)).toEqual(["/run", "/tn", "\\PPM\\RemoteDesktop\\Reattach"]);
  });

  it("passes on the helper's refusal (e.g. no disconnected session) as a failure", async () => {
    auth(true);
    markInstalled();
    win.onTaskRun = () => {
      win.files.set(helperPaths().lastRun, JSON.stringify({ action: "Reattach", ok: false, message: "No Windows session of the PPM user was found.", at: new Date(win.now()).toISOString() }));
    };
    const res = await remoteDesktopRoutes.request("http://localhost/requirements/win-session/reattach", { method: "POST" });
    expect(await res.json()).toMatchObject({ data: { ok: false, message: "No Windows session of the PPM user was found." } });
  });

  it("ignores an answer older than the request and gives up after the wait", async () => {
    auth(true);
    markInstalled();
    win.files.set(helperPaths().lastRun, JSON.stringify({ action: "Reattach", ok: true, message: "old", at: "2020-01-01T00:00:00Z" }));
    const res = await remoteDesktopRoutes.request("http://localhost/requirements/win-session/reattach", { method: "POST" });
    expect(await res.json()).toMatchObject({ data: { ok: false, message: expect.stringContaining("did not answer") } });
  });

  it("does not try when the helper is not set up", async () => {
    auth(true);
    const res = await remoteDesktopRoutes.request("http://localhost/requirements/win-session/reattach", { method: "POST" });
    expect(await res.json()).toMatchObject({ data: { ok: false, message: expect.stringContaining("not set up") } });
    expect(win.calls.some((c) => c[1] === "/run")).toBe(false);
  });
});
