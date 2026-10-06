import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sdNotify } from "../../../src/services/sd-notify.ts";

// Never the real socket: a test run from inside a PPM terminal inherits the live unit's
// NOTIFY_SOCKET, and a message reaching it acts on the live service.
const savedSocket = process.env.NOTIFY_SOCKET;
const dir = mkdtempSync(join(tmpdir(), "ppm-sd-notify-"));

afterEach(() => {
  if (savedSocket === undefined) delete process.env.NOTIFY_SOCKET;
  else process.env.NOTIFY_SOCKET = savedSocket;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a notification that does not reach systemd is logged, not swallowed", async () => {
  process.env.NOTIFY_SOCKET = join(dir, "no-such-socket");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await sdNotify("STATUS=ppm-test");
    // Exit code from systemd-notify, or the spawn error where it is not installed.
    expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringMatching(/^\[sd-notify\] sd_notify STATUS=ppm-test failed \(.+\) — systemd may time the unit out$/),
    );
  } finally {
    warn.mockRestore();
  }
});
