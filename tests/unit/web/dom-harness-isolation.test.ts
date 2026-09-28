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
 *
 * The DOM itself is no longer installed and removed per file: the test preload installs one
 * for the process, because radix reads whether it is in a browser while its module body runs
 * and a file that imported a component with no DOM present left every radix primitive in its
 * server mode for the rest of the run. So what has to be proven here changed shape. It is no
 * longer "the DOM goes away again" but "the DOM stays and each file's own stubs do not".
 */
import { describe, it, expect, afterAll } from "bun:test";
import os from "node:os";
import { installDom, installGlobal, isDomProcessWide, uninstallDom } from "../../helpers/react-dom.tsx";

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

  it("hands a file's own stubs back, and keeps the DOM the preload owns", () => {
    // The two halves of `uninstallDom()` have different scopes, and conflating them is what
    // broke this harness. A stub belongs to the file that installed it: leaving one in place
    // makes every later file test against it, and an `IntersectionObserver` or a `window` of
    // one file's own is enough to fail a suite two directories along. The DOM belongs to the
    // *run*, because radix decides whether it is in a browser while its module body executes
    // — so taking the DOM down mid-run poisons every component imported after that point.
    installDom();
    const dom = globalThis as Record<string, unknown>;
    const realWindow = dom.window;
    const stub = { innerWidth: 1 };
    installGlobal("window", stub);
    expect(dom.window).toBe(stub);

    uninstallDom();

    expect(dom.window).toBe(realWindow);
    expect(typeof document.createElement).toBe("function");
    expect(os.cpus().length).toBe(pristine.cpus);
  });

  it("says which of the two it is, so the contract above is not guessed at", () => {
    // Under `bun test` the preload owns the DOM, so `uninstallDom()` must not remove it. A
    // file-scoped `installDom()` keeps the old behaviour, which is why the flag exists rather
    // than the two cases being told apart by inspection.
    expect(isDomProcessWide()).toBe(true);
  });

  it("still installs a working document", () => {
    installDom();
    const el = document.createElement("div");
    el.textContent = "ok";
    expect(el.textContent).toBe("ok");
  });
});
