/**
 * Two Remote Desktop sessions over the WebRTC relay at once — a phone and a tablet on one host.
 *
 * Each session starts its own MediaMTX, and MediaMTX reloads its config file whenever it changes.
 * With one shared file the second session's start rewrote the first relay's config under it, and
 * the first relay stopped answering the moment the second came up — the first viewer's picture
 * gone, with nothing in either session to say why.
 *
 * It needs a real MediaMTX. PPM's own install lives under PPM_HOME, which the test setup points
 * at a fresh directory, so the binary is taken from `MEDIAMTX_BIN` or PATH, and the test is
 * skipped without one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { startRelay, type RelayHandle } from "../../src/services/remote-desktop/mediamtx-process.ts";
import { uninstallMediamtx } from "../../src/services/remote-desktop/mediamtx-install.service.ts";
import { mediamtxConfigPath } from "../../src/services/remote-desktop/mediamtx-paths.ts";

const binary = process.env.MEDIAMTX_BIN
  ?? Bun.which(process.platform === "win32" ? "mediamtx.exe" : "mediamtx");

/** What the relay's WHEP endpoint says to an offer; any answer at all means it is serving. */
async function whepAnswer(relay: RelayHandle): Promise<string> {
  try {
    const res = await fetch(relay.whepUrl, {
      method: "POST", headers: { "Content-Type": "application/sdp" }, body: "v=0\r\n",
    });
    return `${res.status} ${await res.text()}`;
  } catch (e) {
    return `unreachable: ${(e as Error).message}`;
  }
}

const started: RelayHandle[] = [];
afterEach(() => {
  for (const relay of started.splice(0)) relay.stop();
});

describe.skipIf(!binary)("two relays at once", () => {
  test("a second relay leaves the first one serving its own stream", async () => {
    const first = await startRelay({ binaryPath: binary! });
    started.push(first);
    expect(await whepAnswer(first)).toContain(first.pathName);

    const second = await startRelay({ binaryPath: binary! });
    started.push(second);
    // Long enough for MediaMTX's config watcher to have reloaded, had anything changed.
    await Bun.sleep(1500);

    expect(await whepAnswer(first)).toContain(first.pathName);
    expect(await whepAnswer(second)).toContain(second.pathName);
  }, 30_000);

  test("a stopped relay leaves no config behind", async () => {
    const relay = await startRelay({ binaryPath: binary! });
    const config = mediamtxConfigPath(relay.pathName);
    expect(existsSync(config)).toBe(true);
    relay.stop();
    // Removed on stop, and once more after the process exits, which this waits for.
    for (let i = 0; i < 50 && existsSync(config); i++) await Bun.sleep(20);
    expect(existsSync(config)).toBe(false);
  }, 30_000);

  test("the relay cannot be removed while a session is using it", async () => {
    started.push(await startRelay({ binaryPath: binary! }));
    // Windows cannot delete a running binary, so a removal here would fail part-way through.
    expect(() => uninstallMediamtx()).toThrow("end it first");
  }, 30_000);
});
