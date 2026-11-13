import { afterEach, expect, test } from "bun:test";
import "../../../test-setup.ts";
import { getConfigValue, setConfigValue } from "../../../../src/services/db.service.ts";
import { readStatus } from "../../../../src/services/supervisor-state.ts";
import {
  initShareHost, readShareHostConfigFresh, reloadShareHost, stopShareHost,
} from "../../../../src/services/share-host/share-host-supervision.ts";

const originalArgv = [...process.argv];
const originalConfig = getConfigValue("share_host");
afterEach(() => {
  stopShareHost();
  process.argv = [...originalArgv];
  setConfigValue("share_host", originalConfig ?? "null");
});

test("minimal suppresses an enabled review host at boot and on reload, preserving saved settings", async () => {
  const saved = JSON.stringify({ enabled: true, mode: "quick" });
  setConfigValue("share_host", saved);
  process.argv = [...originalArgv, "--minimal"];
  let spawnAttempts = 0;
  await initShareHost({
    logFd: 1,
    ppmTunnel: () => ({ config: null, linkOn: false }),
    restartPpmConnector: () => { throw new Error("Must not restart PPM's connector"); },
    gate: async () => { spawnAttempts++; throw new Error("Must not spawn in minimal mode"); },
  }, undefined);
  await reloadShareHost();
  expect(spawnAttempts).toBe(0);
  expect(readStatus()).toMatchObject({ shareHostPid: null, shareHostPort: null, shareHostTunnelPid: null });
  expect(readShareHostConfigFresh().enabled).toBe(false);
  expect(getConfigValue("share_host")).toBe(saved);
  process.argv = originalArgv;
  expect(readShareHostConfigFresh().enabled).toBe(true);
});
