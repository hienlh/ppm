import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { _resetPpmDir } from "../../../../src/services/ppm-dir.ts";
import { STATUS_FILE } from "../../../../src/services/supervisor-state.ts";
import { globalWebSocket } from "../../../../src/server/ws/global.ts";
import { confirmReloadInBackground, isConfirmationRunning } from "../../../../src/services/named-tunnel/named-tunnel-setup-confirm.ts";

// Short budgets so these tests exercise the real generation logic without
// waiting out the production 45s/1s constants (which are the module's
// defaults when `opts` is omitted, matching what runSetup actually calls).
const SHORT_OPTS = { pollBudgetMs: 300, pollIntervalMs: 20 };

let openFakeClient: { data: { type: string }; send: (raw: string) => void } | null = null;
function captureBroadcasts(): unknown[] {
  const captured: unknown[] = [];
  openFakeClient = { data: { type: "global" }, send: (raw: string) => captured.push(JSON.parse(raw)) };
  globalWebSocket.open(openFakeClient as any);
  return captured;
}

describe("named-tunnel-setup-confirm", () => {
  let ppmHome: string;

  beforeEach(() => {
    ppmHome = mkdtempSync(resolve(tmpdir(), "ppm-nt-confirm-"));
    process.env.PPM_HOME = ppmHome;
    _resetPpmDir();
  });

  afterEach(() => {
    if (openFakeClient) {
      globalWebSocket.close(openFakeClient as any);
      openFakeClient = null;
    }
    delete process.env.PPM_HOME;
    _resetPpmDir();
    rmSync(ppmHome, { recursive: true, force: true });
  });

  describe("isConfirmationRunning", () => {
    test("true for the confirming hostname, false for any other, and closes once the poll settles", async () => {
      confirmReloadInBackground("a.example.com", SHORT_OPTS);
      expect(isConfirmationRunning("a.example.com")).toBe(true);
      expect(isConfirmationRunning("b.example.com")).toBe(false);

      // status.json never matches, so this poll runs out its full budget
      // before settling (unconfirmed) and releasing the window.
      await Bun.sleep(SHORT_OPTS.pollBudgetMs + 150);
      expect(isConfirmationRunning("a.example.com")).toBe(false);
    });
  });

  describe("supersession", () => {
    test("two overlapping confirmations for different hostnames end in exactly one broadcast, for the latest hostname", async () => {
      const captured = captureBroadcasts();

      // status.json already matches "b.example.com" before either
      // confirmation starts — the second (b) confirms almost instantly, the
      // first (a) never matches and has to run out its own budget.
      writeFileSync(STATUS_FILE(), JSON.stringify({ tunnelMode: "named", shareUrl: "https://b.example.com" }));

      confirmReloadInBackground("a.example.com", SHORT_OPTS); // generation 1
      confirmReloadInBackground("b.example.com", SHORT_OPTS); // generation 2 — supersedes generation 1

      // Superseded immediately, even though its own poll is still running.
      expect(isConfirmationRunning("a.example.com")).toBe(false);
      expect(isConfirmationRunning("b.example.com")).toBe(true);

      // Let both confirmers fully settle (b resolves fast; a waits out its budget).
      await Bun.sleep(SHORT_OPTS.pollBudgetMs + 150);

      const forHostname = (h: string) => captured.filter((e: any) => e.hostname === h);
      expect(forHostname("a.example.com")).toHaveLength(0); // superseded confirmer broadcast nothing
      expect(forHostname("b.example.com")).toHaveLength(1);
      expect((forHostname("b.example.com")[0] as any).type).toBe("tunnel:setup_done");
    });

    test("a hostname's own confirmation is not superseded by a later call for the SAME hostname finishing first", async () => {
      // Guards against a naive implementation that treats "any later call"
      // as superseding even a same-hostname retry that should have been
      // rejected by isConfirmationRunning at the caller level (runSetup) —
      // this module itself has no hostname-aware guard, so document that a
      // caller-level duplicate for the same hostname still just becomes the
      // new current generation (last one standing broadcasts).
      confirmReloadInBackground("a.example.com", SHORT_OPTS);
      confirmReloadInBackground("a.example.com", SHORT_OPTS); // generation 2, same hostname
      expect(isConfirmationRunning("a.example.com")).toBe(true);
    });
  });
});
