/**
 * The DOM harness runs in the same process as every other test in its batch, so
 * anything it changes about a *non-DOM* API leaks into suites that never asked
 * for a browser.
 *
 * One such leak has already happened: Bun backs `os.cpus()` with
 * `globalThis.navigator.hardwareConcurrency`, and happy-dom's navigator reports
 * a hardcoded 8. Installing a DOM therefore made `os.cpus()` answer 8 on a
 * 24-core host, and three tests in `system-metrics/cpu-memory-collector` failed
 * — but only when they happened to share a batch with a DOM test, which reads
 * as flakiness rather than as a cause.
 */
import { describe, it, expect } from "bun:test";
import os from "node:os";

const realCpuCount = os.cpus().length;
const realConcurrency = navigator.hardwareConcurrency;

const { installDom } = await import("../../helpers/react-dom.tsx");

describe("the DOM harness leaves the process alone", () => {
  it("does not change what os.cpus() reports", () => {
    installDom();
    expect(os.cpus().length).toBe(realCpuCount);
  });

  it("keeps the host's core count on the installed navigator", () => {
    installDom();
    expect(navigator.hardwareConcurrency).toBe(realConcurrency);
    // The value it would otherwise have taken. Guards the assertion above from
    // passing vacuously on a machine that really does have 8 cores.
    if (realConcurrency !== 8) expect(navigator.hardwareConcurrency).not.toBe(8);
  });

  it("still installs a working document", () => {
    installDom();
    const el = document.createElement("div");
    el.textContent = "ok";
    expect(el.textContent).toBe("ok");
  });
});
