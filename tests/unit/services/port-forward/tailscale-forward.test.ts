import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseServePorts,
  parseServeUrl,
  parseTailscaleStatus,
  pickServePort,
  serveFailureMessage,
} from "../../../../src/services/port-forward/tailscale-forward.ts";
import type { FakeTailscaleState } from "../../../fixtures/fake-tailscale-state.ts";
import { killLeftover, startForwardChild, type ForwardChild } from "../../../helpers/forward-child.ts";
import { rmRetrying } from "../../../helpers/rm-retrying.ts";

const FAKE = resolve(import.meta.dir, "../../../fixtures/fake-tailscale.ts");

/** The fields of a real `tailscale status --json` (1.102.4) that the parser reads. */
const RUNNING = {
  BackendState: "Running",
  Self: { DNSName: "devbox.tail1234.ts.net." },
  CertDomains: ["devbox.tail1234.ts.net", "ppm.tail1234.ts.net"],
};

describe("parseTailscaleStatus", () => {
  test("a running node with HTTPS certificates can forward, under its name without the root dot", () => {
    expect(parseTailscaleStatus(RUNNING)).toEqual({ available: true, dnsName: "devbox.tail1234.ts.net" });
  });

  test("names why forwarding is unavailable", () => {
    expect(parseTailscaleStatus({ ...RUNNING, BackendState: "NeedsLogin" })).toEqual({ available: false, reason: "Tailscale is signed out on the host" });
    expect(parseTailscaleStatus({ ...RUNNING, BackendState: "Stopped" })).toEqual({ available: false, reason: "Tailscale is turned off on the host" });
    expect(parseTailscaleStatus({ ...RUNNING, Self: { DNSName: "" } })).toEqual({ available: false, reason: "MagicDNS is off in this tailnet" });
    expect(parseTailscaleStatus({ ...RUNNING, CertDomains: null })).toMatchObject({ available: false, reason: expect.stringContaining("HTTPS certificates are off") });
    expect(parseTailscaleStatus(null)).toMatchObject({ available: false });
  });
});

describe("parseServePorts", () => {
  test("counts background handlers and every foreground session's", () => {
    // Shape of `tailscale serve status --json` with one foreground forward running.
    const status = {
      TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
      Web: {},
      Services: { "svc:ppm": { TCP: { "443": { HTTPS: true } } } },
      Foreground: { ff0cda07390a: { TCP: { "5795": { HTTPS: true } } } },
    };
    expect([...parseServePorts(status)].sort((a, b) => a - b)).toEqual([443, 5795, 8443]);
  });

  test("an empty config uses no port", () => {
    expect(parseServePorts({}).size).toBe(0);
    expect(parseServePorts(null).size).toBe(0);
  });
});

describe("pickServePort", () => {
  test("keeps the dev server's own port when Serve has it free", () => {
    expect(pickServePort(5173, new Set([443, 8443]))).toBe(5173);
  });

  test("moves to the next free port when it is taken", () => {
    expect(pickServePort(8443, new Set([443, 8443, 8444]))).toBe(8445);
  });
});

test("parseServeUrl reads the handler's URL, not a login link", () => {
  const ready = "Available within your tailnet:\n\nhttps://devbox.tail1234.ts.net:5795/\n|-- proxy http://127.0.0.1:5796\n\nPress Ctrl+C to exit.\n";
  expect(parseServeUrl(ready)).toBe("https://devbox.tail1234.ts.net:5795/");
  expect(parseServeUrl("Serve is not enabled on your tailnet.\nTo enable, visit:\n\n https://login.tailscale.com/f/serve?node=abc\n")).toBeNull();
});

describe("serveFailureMessage", () => {
  test("points a missing operator grant at the command that fixes it", () => {
    expect(serveFailureMessage("Access denied: serve config denied")).toContain("sudo tailscale set --operator=$USER");
  });

  test("passes the enable link through when Serve is off for the tailnet", () => {
    const message = serveFailureMessage("Serve is not enabled on your tailnet.\nTo enable, visit:\n\n https://login.tailscale.com/f/serve?node=abc\n");
    expect(message).toBe("Tailscale Serve is not enabled in this tailnet: enable it at https://login.tailscale.com/f/serve?node=abc.");
  });

  test("says something when the CLI printed nothing", () => {
    expect(serveFailureMessage("")).toBe("tailscale serve exited without opening the port");
  });
});

/** Poll until `done()` holds, for at most `ms`. */
async function eventually(done: () => boolean, ms = 3000): Promise<boolean> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await Bun.sleep(50)) if (done()) return true;
  return done();
}

type FakeSession = { Web: Record<string, { Handlers: Record<string, { Proxy: string }> }> };

/** A state file for the fake CLI in a temp dir of its own, and the foreground handlers it lists. */
function fakeState() {
  const dir = mkdtempSync(join(tmpdir(), "ts-forward-"));
  const stateFile = join(dir, "state.json");
  writeFileSync(stateFile, "{}");
  const foreground = () => ((JSON.parse(readFileSync(stateFile, "utf8")) as Partial<FakeTailscaleState>).foreground ?? {}) as Record<string, FakeSession>;
  return { dir, stateFile, foreground };
}

describe("a Tailscale forward's hop", () => {
  test("serves the forward's own URL, and answers 421 to any other host", async () => {
    const dev = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => new Response(`host=${req.headers.get("host")}`) });
    const { dir, stateFile, foreground } = fakeState();
    let forward: ForwardChild | undefined;
    try {
      forward = await startForwardChild(["tailscale", String(dev.port), FAKE, stateFile]);
      // Where tailscaled sends the forward's requests: the hop.
      const [session] = Object.values(foreground());
      const hop = Object.values(session!.Web)[0]!.Handlers["/"]!.Proxy;
      const own = await fetch(hop, { headers: { host: new URL(forward.url).host } });
      expect(await own.text()).toBe(`host=localhost:${dev.port}`);
      // A page whose own name resolves to 127.0.0.1 (DNS rebinding), open in a browser on the host.
      const rebound = await fetch(hop, { headers: { host: `rebind.example:${new URL(hop).port}` } });
      expect(rebound.status).toBe(421);
    } finally {
      await forward?.exit();
      for (const pid of Object.keys(foreground())) killLeftover(Number(pid));
      dev.stop(true);
      await rmRetrying(dir);
    }
  }, 15_000);
});

describe("forwards started together", () => {
  test("each gets a serve port of its own, though both read serve status before either handler was up", async () => {
    const { dir, stateFile, foreground } = fakeState();
    let forward: ForwardChild | undefined;
    try {
      // Another handler holds 5173, so the second forward moves up a port: onto the first one's.
      forward = await startForwardChild(["tailscale-pair", "5174,5173", FAKE, stateFile]);
      expect(forward.urls).toEqual(["https://devbox.tail1234.ts.net:5174/", "https://devbox.tail1234.ts.net:5175/"]);
    } finally {
      await forward?.exit();
      for (const pid of Object.keys(foreground())) killLeftover(Number(pid));
      await rmRetrying(dir);
    }
  }, 15_000);
});

// Not on Windows: a Bun child sits in its parent's job object there, and dies with it.
describe.skipIf(process.platform === "win32")("a forward ends with PPM's process", () => {
  test("a fatal exit stops the tailscale serve child, so no handler is left pointing at the dead hop", async () => {
    const { dir, stateFile, foreground } = fakeState();
    try {
      const forward = await startForwardChild(["tailscale", "5173", FAKE, stateFile]);
      expect(Object.keys(foreground())).toHaveLength(1);
      expect(await forward.exit()).toBe(3);
      // The fake drops its session when stopped, as tailscaled drops a foreground handler.
      expect(await eventually(() => Object.keys(foreground()).length === 0)).toBe(true);
    } finally {
      for (const pid of Object.keys(foreground())) killLeftover(Number(pid));
      await rmRetrying(dir);
    }
  }, 15_000);
});
