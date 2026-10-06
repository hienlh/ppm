import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { configService } from "../../../../src/services/config.service.ts";
import { setConfigValue } from "../../../../src/services/db.service.ts";
import { defaultRunner } from "../../../../src/services/host-info/spawn-runner.ts";
import {
  disableService,
  enableService,
  ensureServiceOnStartup,
  ppmPublicPort,
  readServiceSetting,
  readState,
  renameService,
  TailscaleServiceError,
} from "../../../../src/services/tailscale/tailscale-app-service.ts";
import type { TailscaleCli } from "../../../../src/services/tailscale/tailscale-cli.ts";
import { readFakeCalls, type FakeTailscaleState } from "../../../fixtures/fake-tailscale-state.ts";

const FAKE = resolve(import.meta.dir, "../../../fixtures/fake-tailscale.ts");

let dir: string;
let stateFile: string;
let cli: TailscaleCli;
let authBefore: ReturnType<typeof configService.get<"auth">>;

const write = (state: Partial<FakeTailscaleState>) =>
  writeFileSync(stateFile, JSON.stringify({ operatorUser: userInfo().username, ...state }));
const read = (): FakeTailscaleState => JSON.parse(readFileSync(stateFile, "utf8"));
const update = (patch: Partial<FakeTailscaleState>) => writeFileSync(stateFile, JSON.stringify({ ...read(), ...patch }));
const serveCalls = () => readFakeCalls(stateFile).filter((c) => c[0] === "serve" && c[1] !== "status");
const target = () => `http://127.0.0.1:${ppmPublicPort()}`;
const servicePointingAt = (proxy: string) => ({
  "svc:ppm": { TCP: { "443": { HTTPS: true } }, Web: { "ppm.tail1234.ts.net:443": { Handlers: { "/": { Proxy: proxy } } } } },
});

async function rejection(promise: Promise<unknown>): Promise<TailscaleServiceError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(TailscaleServiceError);
    return e as TailscaleServiceError;
  }
  throw new Error("expected a TailscaleServiceError");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fake-tailscale-"));
  stateFile = join(dir, "state.json");
  cli = { argv: [process.execPath, FAKE, stateFile], runner: defaultRunner };
  authBefore = configService.get("auth");
  configService.set("auth", { ...authBefore, enabled: true, token: "test-token" });
  setConfigValue("tailscale_service", "{}");
  write({});
});

afterEach(() => {
  configService.set("auth", authBefore);
  rmSync(dir, { recursive: true, force: true });
});

describe("enableService", () => {
  test("points svc:ppm at PPM, remembers it, and waits for an admin", async () => {
    const state = await enableService({}, cli);
    expect(serveCalls()).toEqual([["serve", "--service=svc:ppm", "--https=443", "--bg", "--yes", target()]]);
    expect(readServiceSetting()).toEqual({ enabled: true, name: "ppm", target: target() });
    expect(state.enabled).toBe(true);
    expect(state.service).toMatchObject({ name: "ppm", url: "https://ppm.tail1234.ts.net/", advertised: true, approved: false, pointsAtPpm: true });

    update({ approvedServices: ["ppm"] });
    expect((await readState(undefined, cli)).service.approved).toBe(true);
  });

  test("refuses while a setup step is missing, naming the step", async () => {
    write({ tags: [] });
    expect((await rejection(enableService({}, cli))).message).toContain("Tag this machine");
    write({ https: false });
    expect((await rejection(enableService({}, cli))).message).toContain("HTTPS certificates");
    write({ backendState: "NeedsLogin" });
    expect((await rejection(enableService({}, cli))).message).toContain("Sign this machine in");
    write({ operatorUser: "someone-else" });
    if (process.platform === "linux") expect((await rejection(enableService({}, cli))).message).toContain("operator");
    expect(readServiceSetting().enabled).toBeNull();
  });

  test("refuses without PPM's password, which would open PPM to the whole tailnet", async () => {
    configService.set("auth", { ...authBefore, enabled: false });
    expect((await rejection(enableService({}, cli))).status).toBe(403);
    expect(serveCalls()).toEqual([]);
  });

  test("never takes over a service pointing somewhere else unless asked", async () => {
    write({ services: servicePointingAt("http://127.0.0.1:8000") });
    const conflict = await rejection(enableService({}, cli));
    expect(conflict).toMatchObject({ status: 409, code: "conflict" });
    expect(conflict.message).toContain("svc:ppm already serves http://127.0.0.1:8000");
    expect(serveCalls()).toEqual([]);

    await enableService({ replace: true }, cli);
    expect((await readState(undefined, cli)).service.target).toBe(target());
  });

  test("re-points its own handler from an old port without asking", async () => {
    setConfigValue("tailscale_service", JSON.stringify({ enabled: true, name: "ppm", target: "http://127.0.0.1:9999" }));
    write({ services: servicePointingAt("http://127.0.0.1:9999") });
    await enableService({}, cli);
    expect((await readState(undefined, cli)).service.pointsAtPpm).toBe(true);
  });

  test("moving to a new name sets the new service before clearing the old", async () => {
    await enableService({}, cli);
    await enableService({ name: "ppm-mac" }, cli);
    expect(serveCalls().slice(1)).toEqual([
      ["serve", "--service=svc:ppm-mac", "--https=443", "--bg", "--yes", target()],
      ["serve", "clear", "svc:ppm"],
    ]);
    expect(readServiceSetting()).toMatchObject({ enabled: true, name: "ppm-mac" });
  });

  test("rejects a name that is not a DNS label", async () => {
    expect((await rejection(enableService({ name: "My PPM" }, cli))).status).toBe(400);
  });
});

describe("disableService", () => {
  test("clears the service while it points at PPM", async () => {
    await enableService({}, cli);
    const state = await disableService(cli);
    expect(serveCalls().at(-1)).toEqual(["serve", "clear", "svc:ppm"]);
    expect(state.enabled).toBe(false);
    expect(state.service.target).toBeNull();
  });

  test("leaves a service alone that someone pointed elsewhere", async () => {
    await enableService({}, cli);
    update({ services: servicePointingAt("http://127.0.0.1:8000") });
    await disableService(cli);
    expect(serveCalls().some((c) => c[1] === "clear")).toBe(false);
    expect(readServiceSetting().enabled).toBe(false);
  });
});

test("an address set up by hand that points at PPM reads as on until the switch is used", async () => {
  write({ services: servicePointingAt(target()), advertiseServices: ["svc:ppm"], approvedServices: ["ppm"] });
  expect((await readState(undefined, cli)).enabled).toBe(true);
  expect((await readState("other", cli)).enabled).toBe(false);
  expect((await rejection(renameService("other", cli))).status).toBe(409);

  await disableService(cli);
  expect(serveCalls()).toEqual([["serve", "clear", "svc:ppm"]]);
  expect((await readState(undefined, cli)).enabled).toBe(false);
});

test("renameService only renames while the address is off", async () => {
  expect((await renameService("ppm-dev", cli)).service.name).toBe("ppm-dev");
  await enableService({}, cli);
  expect((await rejection(renameService("other", cli))).status).toBe(409);
});

describe("ensureServiceOnStartup", () => {
  const fast = () => ({ cli, attempts: 3, delayMs: 1 });

  test("does nothing while the switch is off", async () => {
    expect(await ensureServiceOnStartup(fast())).toBe("off");
    expect(serveCalls()).toEqual([]);
  });

  test("puts back a handler that went missing", async () => {
    setConfigValue("tailscale_service", JSON.stringify({ enabled: true, name: "ppm", target: target() }));
    expect(await ensureServiceOnStartup(fast())).toBe("applied");
    expect((await readState(undefined, cli)).service.pointsAtPpm).toBe(true);
    expect(await ensureServiceOnStartup(fast())).toBe("ok");
  });

  test("leaves a service someone else now uses", async () => {
    setConfigValue("tailscale_service", JSON.stringify({ enabled: true, name: "ppm", target: target() }));
    write({ services: servicePointingAt("http://127.0.0.1:8000") });
    expect(await ensureServiceOnStartup(fast())).toBe("foreign");
    expect(serveCalls()).toEqual([]);
  });

  test("gives up quietly when Tailscale never comes up", async () => {
    setConfigValue("tailscale_service", JSON.stringify({ enabled: true, name: "ppm", target: target() }));
    write({ backendState: "NoState" });
    expect(await ensureServiceOnStartup(fast())).toBe("unavailable");
  });

  test("says in the log why the address was not put back", async () => {
    // The server ignores the answer, so without these lines the address stays down unexplained.
    setConfigValue("tailscale_service", JSON.stringify({ enabled: true, name: "ppm", target: target() }));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      write({ backendState: "NoState" });
      expect(await ensureServiceOnStartup(fast())).toBe("unavailable");
      write({ tags: [] });
      expect(await ensureServiceOnStartup(fast())).toBe("unavailable");
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe("[tailscale] svc:ppm not re-applied at startup: tailscaled not Running after 3 checks over 0s (last state: NoState)");
      expect(lines[1]).toStartWith("[tailscale] svc:ppm not re-applied at startup: Tag this machine first");
    } finally {
      warn.mockRestore();
    }
  });
});
