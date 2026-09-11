/**
 * Every long-press must be disarmed on `touchcancel`, and there is no way to see
 * that it is not.
 *
 * A press that opens a menu is a timer armed on `touchstart` and cleared on
 * `touchmove`/`touchend`, which reads as complete. It is not: once the browser
 * decides the gesture belongs to a scroll it fires **`touchcancel`** and then
 * delivers no further `touchmove` or `touchend` to that element. The timer
 * survives the scroll and fires into it — a context menu over a list the finger
 * is already moving, with nothing the reader did to ask for one. A movement
 * tolerance cannot catch it either, because the moves it would have measured are
 * never delivered.
 *
 * It reproduces on a phone and on nothing else: a mouse has no touch events, and
 * a desktop browser's device emulation dispatches move/end faithfully. So it
 * cannot be caught by a rendered test, and it was live in **six** separate
 * hand-rolled long-presses at once — which is the other half of the problem. The
 * check is therefore on the source: a file that arms a timer from `onTouchStart`
 * has to name `onTouchCancel` too.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const WEB = resolve(import.meta.dir, "../../../src/web");

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

/** Files that both handle touchstart and arm a timer — i.e. hold a press open. */
function pressSites(): { file: string; src: string }[] {
  return sources(WEB)
    .map((file) => ({ file: relative(WEB, file), src: readFileSync(file, "utf8") }))
    .filter(({ src }) => /onTouchStart/.test(src) && /setTimeout/.test(src));
}

describe("a long-press is disarmed when the browser takes the gesture", () => {
  it("finds the press sites it is meant to be checking", () => {
    // Guards the guard: a rename of the handler prop would otherwise make this
    // suite pass by matching nothing at all.
    const sites = pressSites().map((s) => s.file);
    // Six, down from seven: the git panel used to hand-roll its own press and
    // now goes through the adaptive menu, which holds one for it. That is a
    // press site *removed*, not one that stopped being checked — and
    // `git-panel-context-menu.test.ts` is what keeps it from coming back.
    expect(sites.length).toBeGreaterThanOrEqual(6);
    expect(sites).toContain("components/ui/adaptive-context-menu.tsx");
    expect(sites).toContain("components/os-explorer/use-coarse-long-press.ts");
  });

  it("handles touchcancel everywhere a press is armed", () => {
    const missing = pressSites()
      .filter(({ src }) => !/onTouchCancel|"touchcancel"|'touchcancel'/.test(src))
      .map(({ file }) => file);
    expect(missing).toEqual([]);
  });

  it("clears the timer when the element goes away mid-press", () => {
    // The git panel refreshes its file list on every save, so a row can unmount
    // under a finger; the timer would then fire for a row that no longer exists.
    // That press now lives in the adaptive menu, which is why it is the entry
    // that has to carry the cleanup.
    const guarded = [
      "components/ui/adaptive-context-menu.tsx",
      "components/os-explorer/use-coarse-long-press.ts",
      "../web/hooks/use-touch-tab-drag.ts",
    ];
    for (const file of guarded) {
      const src = readFileSync(join(WEB, file), "utf8");
      // Any shape of cleanup will do — `() => clear`, `() => () => clearTimeout(...)`.
      expect(/useEffect\(\s*\(\)\s*=>[\s\S]{0,90}?(clearTimeout|clear\b|cancel\b)/.test(src), file).toBe(true);
    }
  });
});
