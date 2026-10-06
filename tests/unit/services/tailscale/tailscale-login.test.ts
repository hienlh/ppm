import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultRunner } from "../../../../src/services/host-info/spawn-runner.ts";
import {
  cancelLogin,
  flagsFromRevertRefusal,
  getLoginSnapshot,
  loginFailure,
  splitShellWords,
  startLogin,
  takeJsonObjects,
} from "../../../../src/services/tailscale/tailscale-login.ts";
import type { TailscaleLoginState } from "../../../../src/shared/tailscale-setup.ts";
import { readFakeCalls, type FakeTailscaleState } from "../../../fixtures/fake-tailscale-state.ts";

const FAKE = resolve(import.meta.dir, "../../../fixtures/fake-tailscale.ts");

/** The refusal exactly as `tailscale up` prints it (cmd/tailscale/cli/up.go). */
const REFUSAL = "Error: changing settings via 'tailscale up' requires mentioning all\n"
  + "non-default flags. To proceed, either re-run your command with --reset or\n"
  + "use the command below to explicitly mention the current value of\n"
  + "all non-default settings:\n\n"
  + "\ttailscale up --json --advertise-tags=tag:server --hostname='my box' --operator=dev\n\n";

describe("pure helpers", () => {
  test("splitShellWords undoes shellquote.Join", () => {
    expect(splitShellWords(" --json --hostname='my box' --x=a\\ b --y=\"q\\\"t\"")).toEqual(["--json", "--hostname=my box", "--x=a b", '--y=q"t']);
    expect(splitShellWords("--operator= --accept-routes")).toEqual(["--operator=", "--accept-routes"]);
  });

  test("flagsFromRevertRefusal returns the command that keeps every current setting", () => {
    expect(flagsFromRevertRefusal(REFUSAL)).toEqual(["--json", "--advertise-tags=tag:server", "--hostname=my box", "--operator=dev"]);
    expect(flagsFromRevertRefusal(REFUSAL.replace(" --json", ""))).toEqual(["--json", "--advertise-tags=tag:server", "--hostname=my box", "--operator=dev"]);
    expect(flagsFromRevertRefusal("Access denied: checkprefs access denied")).toBeNull();
  });

  test("takeJsonObjects reads indented objects as they arrive", () => {
    const first = '{\n\t"AuthURL": "https://login.tailscale.com/a/x",\n\t"QR": "data:image/png;base64,{}"\n}\n{\n\t"Backend';
    const taken = takeJsonObjects(first);
    expect(taken.objects).toEqual([{ AuthURL: "https://login.tailscale.com/a/x", QR: "data:image/png;base64,{}" }]);
    expect(takeJsonObjects(`${taken.rest}State": "Running"\n}\n`).objects).toEqual([{ BackendState: "Running" }]);
  });

  test("loginFailure tells a missing operator grant from other failures", () => {
    expect(loginFailure("Access denied: checkprefs access denied").state).toBe("needs-operator");
    expect(loginFailure("failed to connect to local tailscaled; it doesn't appear to be running\n")).toEqual({
      state: "error", message: "failed to connect to local tailscaled; it doesn't appear to be running",
    });
  });
});

describe("startLogin against a fake tailscale", () => {
  let dir: string;
  let stateFile: string;
  let deps: { argv: string[]; runner: typeof defaultRunner };
  const write = (state: Partial<FakeTailscaleState>) => writeFileSync(stateFile, JSON.stringify(state));
  const read = (): FakeTailscaleState => JSON.parse(readFileSync(stateFile, "utf8"));
  const update = (patch: Partial<FakeTailscaleState>) => write({ ...read(), ...patch });

  async function waitFor(state: TailscaleLoginState, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (getLoginSnapshot().state === state) return getLoginSnapshot();
      await Bun.sleep(20);
    }
    throw new Error(`login stayed ${JSON.stringify(getLoginSnapshot())}, expected ${state}`);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fake-tailscale-"));
    stateFile = join(dir, "state.json");
    deps = { argv: [process.execPath, FAKE, stateFile], runner: defaultRunner };
  });

  afterEach(() => {
    cancelLogin();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a fresh install signs in with the link tailscale up prints", async () => {
    write({ backendState: "NeedsLogin", controlUrl: "" });
    await startLogin(deps);
    const waiting = await waitFor("waiting");
    expect(waiting.url).toBe("https://login.tailscale.com/a/fake0123456789");
    update({ backendState: "Running" });
    expect((await waitFor("success")).url).toBeNull();
  });

  test("a node signed in before is retried with the flags tailscale up asked for", async () => {
    write({ backendState: "NeedsLogin", nonDefaultFlags: ["--operator=dev"] });
    await startLogin(deps);
    await waitFor("waiting");
    const ups = readFakeCalls(stateFile).filter((c) => c[0] === "up");
    expect(ups).toEqual([["up", "--json"], ["up", "--json", "--operator=dev"]]);
    update({ backendState: "Running" });
    await waitFor("success");
  });

  test("a machine an admin must approve says so", async () => {
    write({ backendState: "NeedsLogin", controlUrl: "" });
    await startLogin(deps);
    await waitFor("waiting");
    update({ backendState: "NeedsMachineAuth" });
    expect((await waitFor("needs-approval")).message).toContain("approve");
  });

  test("tailscaled refusing the user asks for the operator grant", async () => {
    write({ backendState: "NeedsLogin", accessDenied: true });
    await startLogin(deps);
    await waitFor("needs-operator");
  });

  test("a machine that is switched off is turned on with a bare tailscale up", async () => {
    write({ backendState: "Stopped" });
    await startLogin(deps);
    await waitFor("success");
    expect(readFakeCalls(stateFile).filter((c) => c[0] === "up")).toEqual([["up"]]);
    expect(read().backendState).toBe("Running");
  });

  test("a machine already signed in starts nothing", async () => {
    write({ backendState: "Running" });
    expect((await startLogin(deps)).state).toBe("success");
    expect(readFakeCalls(stateFile).some((c) => c[0] === "up")).toBe(false);
  });

  test("cancel stops the sign-in and a second start gets a fresh one", async () => {
    write({ backendState: "NeedsLogin", controlUrl: "" });
    await startLogin(deps);
    await waitFor("waiting");
    expect(cancelLogin()).toEqual({ state: "cancelled", url: null, message: null });
    update({ backendState: "Running" });
    await Bun.sleep(150);
    expect(getLoginSnapshot().state).toBe("cancelled");

    update({ backendState: "NeedsLogin" });
    await startLogin(deps);
    await waitFor("waiting");
  });

  test("a start while one is waiting returns the one waiting", async () => {
    write({ backendState: "NeedsLogin", controlUrl: "" });
    await startLogin(deps);
    await waitFor("waiting");
    expect((await startLogin(deps)).state).toBe("waiting");
    expect(readFakeCalls(stateFile).filter((c) => c[0] === "up")).toHaveLength(1);
  });

  /**
   * A CLI that answers `status --json` and a bare `tailscale up` itself, holding the one named
   * `held` until the test releases it: a start parked at that await while the person cancels
   * and starts again. A sign-in still runs the fake, against `file`, so each start given a CLI
   * of its own shows which start a sign-in child belongs to.
   */
  function cliHeldAt(file: string, backendState: string, held?: "status --json" | "up") {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => { reach = resolve; });
    const runner: typeof defaultRunner = async (argv, timeoutMs) => {
      const command = argv.slice(3).join(" ");
      if (command !== "status --json" && command !== "up") return defaultRunner(argv, timeoutMs);
      if (command === held) { reach(); await released; }
      return { stdout: command === "up" ? "" : JSON.stringify({ BackendState: backendState }), stderr: "", code: 0, timedOut: false };
    };
    return { cli: { argv: [process.execPath, FAKE, file], runner }, release, reached };
  }

  test("a start cancelled while it reads the status leaves the next start's sign-in alone", async () => {
    write({ backendState: "NeedsLogin", controlUrl: "" });
    const cancelledFile = join(dir, "cancelled.json");
    writeFileSync(cancelledFile, JSON.stringify({ backendState: "NeedsLogin", controlUrl: "", authUrl: "https://login.tailscale.com/a/cancelled" }));
    const cancelled = cliHeldAt(cancelledFile, "NeedsLogin", "status --json");
    const next = cliHeldAt(stateFile, "NeedsLogin", "status --json");

    const first = startLogin(cancelled.cli);
    cancelLogin();
    const second = startLogin(next.cli);
    next.release();
    await second;
    // The cancelled start's read comes back last, while the next one is "starting" too.
    cancelled.release();
    await first;

    expect((await waitFor("waiting")).url).toBe("https://login.tailscale.com/a/fake0123456789");
    expect(readFakeCalls(cancelledFile).filter((c) => c[0] === "up")).toEqual([]);
  });

  test("a turn-on that ends after a cancel leaves the next sign-in alone", async () => {
    write({ backendState: "NeedsLogin", controlUrl: "" });
    const switchedOff = cliHeldAt(join(dir, "stopped.json"), "Stopped", "up");

    const first = startLogin(switchedOff.cli);
    await switchedOff.reached;
    cancelLogin();
    await startLogin(cliHeldAt(stateFile, "NeedsLogin").cli);
    const waiting = await waitFor("waiting");
    // The bare `tailscale up` of the cancelled start answers only now.
    switchedOff.release();
    await first;

    expect(getLoginSnapshot()).toEqual(waiting);
  });
});
