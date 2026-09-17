/**
 * A tooltip that opens the instant the pointer touches its trigger is not a tooltip, it is
 * an obstacle.
 *
 * With `delayDuration = 0` the shared tooltip fired while the pointer was merely crossing a
 * toolbar on its way somewhere else, and — because Radix content is hoverable by default —
 * the box that appeared under the pointer then swallowed the wheel: the panel beneath it
 * stopped scrolling until the pointer left. Both halves are invisible in review, since the
 * markup of an instant tooltip and a delayed one is identical.
 *
 * The rail's hand-rolled hover labels are the same promise made in CSS, and they are the
 * ones that drift: a new icon button copies the class string of an old one, and a label
 * added without `hover-label-delayed` reads exactly like the rest. So the check is on the
 * source — the shared component keeps a real delay and non-interactive content, and every
 * hover label in the app carries the delay class the stylesheet defines.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const WEB = resolve(import.meta.dir, "../../../src/web");
const TOOLTIP = join(WEB, "components/ui/tooltip.tsx");
const GLOBALS = join(WEB, "styles/globals.css");

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

describe("shared tooltip", () => {
  const src = readFileSync(TOOLTIP, "utf8");

  it("waits before opening", () => {
    const delay = src.match(/TOOLTIP_DELAY_MS\s*=\s*(\d+)/);
    expect(delay).not.toBeNull();
    expect(Number(delay![1])).toBeGreaterThanOrEqual(300);
    expect(src).toContain("delayDuration = TOOLTIP_DELAY_MS");
  });

  it("never takes the pointer from what it covers", () => {
    expect(src).toContain("disableHoverableContent = true");
    // On the content itself, so a wheel over the box still reaches the panel under it.
    expect(src).toMatch(/className=\{cn\(\s*\n?\s*"pointer-events-none /);
  });
});

describe("hand-rolled hover labels", () => {
  it("wait as long as the real tooltip", () => {
    const css = readFileSync(GLOBALS, "utf8");
    const rule = css.match(/\.hover-label-delayed\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    // An animation-delay, not merely an animation: without it the label is instant again.
    expect(rule![1]).toMatch(/animation:[^;]*\b0?\.\d+s\s+\S+\s+0?\.\d+s\s+both/);
  });

  it("all carry the delay class", () => {
    const offenders: string[] = [];
    for (const file of sources(WEB)) {
      const text = readFileSync(file, "utf8");
      for (const [classes] of text.matchAll(/"[^"]*can-hover:group-hover:block[^"]*"/g)) {
        if (!classes.includes("hover-label-delayed")) offenders.push(relative(WEB, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
