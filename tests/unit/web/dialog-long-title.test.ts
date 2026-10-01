/**
 * A dialog holding one long unbreakable string, which is the shape of every
 * systemd unit name, log line and file path the System Monitor shows.
 *
 * Two silent hazards are pinned here, both measured in a real browser against
 * `app-google\x2dchrome@8d02dd75073349a0bbb128b6427e7818.service`:
 *
 * 1. `DialogContent` is a **grid**, and an implicit `auto` track takes its base
 *    size from its items' *min-content* contribution. One 79-character log line
 *    therefore sized the column at **693px inside a 512px dialog** — the title
 *    and the log box drew outside the panel entirely, over the page behind it.
 *    `overflow-wrap: break-word` (Tailwind's `break-words`) cannot prevent it:
 *    by specification that property does not affect min-content size. Only a
 *    track with a zero base size does, hence `grid-cols-[minmax(0,1fr)]`.
 * 2. The close button is `absolute top-4 right-4`, i.e. directly over the
 *    header's first line, so a title long enough to reach the corner rendered
 *    underneath the X with nothing to indicate it. The header reserves that
 *    corner — but only when the button is actually rendered.
 *
 * And the caller's own trap: the primitive caps width with a **`sm:` variant**,
 * so a bare `max-w-2xl` from a caller emits a rule that loses to `sm:max-w-lg`
 * at every width at which it would have mattered. The dialog is then 512px wide
 * while the source says 672 — and nothing reports it, exactly like a colour
 * class naming a token that does not exist.
 *
 * These are class-string assertions on purpose: there is no DOM under bun:test,
 * so the layout itself cannot be measured here. What they pin is that the
 * mitigation is still present in the file it has to be in.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const dialog = read("src/web/components/ui/dialog.tsx");

describe("DialogContent cannot be widened by its own contents", () => {
  it("sizes its column from zero, not from min-content", () => {
    expect(dialog).toContain("grid-cols-[minmax(0,1fr)]");
  });

  it("still declares the grid it is constraining", () => {
    // `grid-cols-*` is inert without `grid`, and a caller passing `flex` would
    // win the display group in tailwind-merge — which is fine, since a flex item
    // shrinks. What must not happen is the class being dropped from here.
    expect(dialog).toMatch(/\bgrid grid-cols-\[minmax\(0,1fr\)\]/);
  });
});

describe("the close button's corner is reserved", () => {
  it("the header gets right padding as wide as the button's own inset", () => {
    // `right-4` + a `size-4` glyph = the rightmost 2rem of the panel.
    expect(dialog).toContain("[&_[data-slot=dialog-header]]:pr-8");
    expect(dialog).toMatch(/absolute top-4 right-4/);
  });

  it("the padding is conditional on the button existing", () => {
    expect(dialog).toMatch(/showCloseButton && "\[&_\[data-slot=dialog-header\]\]:pr-8"/);
  });

  it("the header it targets carries that slot", () => {
    // The selector and the attribute are in the same file and still have to
    // agree; a renamed slot would make the padding a no-op.
    expect(dialog).toContain('data-slot="dialog-header"');
  });
});

describe("a System Monitor dialog's own width is not a dead class", () => {
  it("the primitive's cap is a sm: variant — which is what makes a bare max-w lose", () => {
    expect(dialog).toContain("sm:max-w-lg");
  });

  const callers = [
    "src/web/components/system/services/service-details-sheet.tsx",
    "src/web/components/system/process-details-dialog.tsx",
  ];

  for (const file of callers) {
    it(`${file.split("/").pop()} overrides it at the same variant`, () => {
      const src = read(file);
      const widths = [...src.matchAll(/<DialogContent className="([^"]*)"/g)]
        .flatMap((m) => m[1]!.split(/\s+/))
        .filter((c) => /(^|:)max-w-/.test(c));
      expect(widths.length).toBeGreaterThan(0);
      for (const cls of widths) expect(cls.startsWith("sm:")).toBe(true);
    });
  }
});
