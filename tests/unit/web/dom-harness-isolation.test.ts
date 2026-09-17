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
import { describe, it, expect, afterAll } from "bun:test";
import os from "node:os";
import { installDom, uninstallDom } from "../../helpers/react-dom.tsx";

/**
 * The real values, taken from a process with no DOM in it.
 *
 * Reading them at module scope here cannot work, and the version of this file that did was
 * green for the wrong reason. Four of the five DOM test files call `installDom()` while their
 * own module bodies run, and two of them sort before this one — so in a full-suite run the
 * "real" value captured here was already happy-dom's 8. Every assertion then passed against a
 * completely unfixed harness, *including* the anti-vacuity guard, which skips itself when the
 * baseline is 8. It only looked like a guard because it happened to be run in a batch it
 * loaded first in. A subprocess has no such history, whatever ran before this file.
 */
const pristine = (() => {
  const probe = Bun.spawnSync([
    process.execPath, "-e",
    'console.log(JSON.stringify({ cpus: require("node:os").cpus().length, hc: navigator.hardwareConcurrency }))',
  ]);
  return JSON.parse(probe.stdout.toString()) as { cpus: number; hc: number };
})();

/** What the globals `installDom` does not touch have to still be, afterwards. */
const BUN_OWNED = { File, FormData, Blob, URL } as const;

afterAll(uninstallDom);

describe("the DOM harness leaves the process alone", () => {
  it("does not change what os.cpus() reports", () => {
    installDom();
    expect(os.cpus().length).toBe(pristine.cpus);
  });

  it("keeps the host's core count on the installed navigator", () => {
    installDom();
    expect(navigator.hardwareConcurrency).toBe(pristine.hc);
    // The value it would otherwise have taken. Guards the assertion above from
    // passing vacuously on a machine that really does have 8 cores.
    if (pristine.hc !== 8) expect(navigator.hardwareConcurrency).not.toBe(8);
  });

  it("leaves the upload primitives alone, because the routes gate on them", () => {
    // `projects.ts`, `files.ts` and `chat.ts` all decide whether a request carries an upload
    // with `x instanceof File`, and `projects-routes.test.ts` posts a real `FormData` holding a
    // real `Blob` expecting a 200. Those ran in the same process as this harness and passed
    // only because `tests/unit/routes/` sorts before `tests/unit/web/` — one filename away from
    // a failure with nothing in it to suggest a DOM was responsible.
    installDom();
    expect(File).toBe(BUN_OWNED.File);
    expect(FormData).toBe(BUN_OWNED.FormData);
    expect(Blob).toBe(BUN_OWNED.Blob);
    expect(URL).toBe(BUN_OWNED.URL);
    // And they still work together, which is the shape the routes actually see.
    const body = new FormData();
    body.append("file", new Blob(["x"], { type: "text/plain" }), "a.txt");
    expect(body.get("file")).toBeInstanceOf(File);
  });

  it("hands every global back when the file that installed it is done", () => {
    // The event classes cannot be left to Bun — a happy-dom node rejects an event built in
    // another realm — so they are installed and then restored, which is the only reason a
    // suite that runs after a DOM file gets its own `Event` back.
    installDom();
    const dom = globalThis as Record<string, unknown>;
    const [domEvent, domWindow, domDocument] = [dom.Event, dom.window, dom.document];
    expect(typeof document.createElement).toBe("function");

    uninstallDom();

    // Identity rather than absence: another file in the same batch may legitimately have had a
    // `window` stub of its own before this one ran, and the guarantee is that it gets *that*
    // back — not that the name is unbound.
    expect(dom.Event).not.toBe(domEvent);
    expect(dom.window).not.toBe(domWindow);
    expect(dom.document).not.toBe(domDocument);
    expect(os.cpus().length).toBe(pristine.cpus);

    installDom(); // the rest of this file, and anything after it, still gets one on request
    expect(typeof document.createElement).toBe("function");
  });

  it("still installs a working document", () => {
    installDom();
    const el = document.createElement("div");
    el.textContent = "ok";
    expect(el.textContent).toBe("ok");
  });
});
