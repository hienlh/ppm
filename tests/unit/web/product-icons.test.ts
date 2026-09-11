/**
 * The app's chrome draws one icon set, and the import path is what enforces it.
 *
 * 234 files were switched from `lucide-react` to `@/lib/icons` in one pass. One
 * file that keeps the old path renders lucide's outline beside Fluent's filled
 * one at the same size — which reads as "this button looks slightly wrong"
 * rather than as an error, and nothing else catches it: both imports typecheck,
 * both render, both accept `className`.
 *
 * The prop tests call the `forwardRef`'s own `render` directly. That is legal
 * here precisely because `fluentIcon` uses no hooks — this suite has no DOM or
 * React renderer, and the alternative (asserting on the source text) would not
 * notice `strokeWidth` being spread onto the `<svg>` after all.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as icons from "../../../src/web/lib/icons.ts";
import { FLUENT_NAMES, LUCIDE_NAMES, ICON_VIEW_BOX } from "../../../src/web/lib/icons.generated.tsx";

const WEB = resolve(import.meta.dir, "../../../src/web");
/** The one file allowed to name lucide: it is what re-exports the fallbacks. */
const GENERATED = "lib/icons.generated.tsx";

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

const files = sources(WEB);

describe("one icon set, enforced by the import path", () => {
  it("has exactly one file importing lucide-react", () => {
    const offenders = files
      .filter((f) => /["']lucide-react["']/.test(readFileSync(f, "utf8")))
      .map((f) => relative(WEB, f));
    expect(offenders).toEqual([GENERATED]);
  });

  it("resolves every name the app imports from @/lib/icons", () => {
    // A missing name is a TypeScript error today, but only while every import
    // is static and spelled out. This also pins the *inventory*: the generated
    // module is regenerated from a table, and a name dropped from that table
    // would otherwise fail 200 files at once with no single place to look.
    const known = new Set([...FLUENT_NAMES, ...LUCIDE_NAMES]);
    const unknown = new Set<string>();
    for (const f of files) {
      if (relative(WEB, f) === GENERATED) continue;
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"@\/lib\/icons"/gs)) {
        for (const raw of m[1]!.split(",")) {
          const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
          if (!name) continue;
          if (name === "LucideIcon" || name === "LucideProps") continue;
          if (!known.has(name)) unknown.add(name);
        }
      }
    }
    expect([...unknown]).toEqual([]);
  });

  it("keeps the lucide fallbacks to the reviewed list", () => {
    // Falling back is a decision, not a shortcut: each of these is a glyph
    // Fluent does not have, and the list growing quietly is how an icon set
    // stops being an icon set.
    expect([...LUCIDE_NAMES]).toEqual([
      "CaseSensitive",
      "FileDiff",
      "FileJson",
      "FolderGit2",
      "GitCommitHorizontal",
      "Github",
      "Hexagon",
      "Network",
      "PowerOff",
      "Regex",
      "ReplaceAll",
      "Scan",
      "ServerOff",
      "Slash",
      "WholeWord",
    ]);
  });

  it("exports every name it claims, and the two sets do not overlap", () => {
    for (const name of [...FLUENT_NAMES, ...LUCIDE_NAMES]) {
      expect(icons[name as keyof typeof icons], name).toBeDefined();
    }
    const both = FLUENT_NAMES.filter((n) => LUCIDE_NAMES.includes(n));
    expect(both).toEqual([]);
  });
});

/** Render a Fluent-backed icon's element tree without a DOM. */
const FORWARD_REF = Symbol.for("react.forward_ref");
function renderIcon(name: string, props: Record<string, unknown> = {}) {
  const Icon = icons[name as keyof typeof icons] as unknown as {
    $$typeof: symbol;
    render: (p: Record<string, unknown>, ref: unknown) => { props: Record<string, unknown> };
  };
  expect(Icon.$$typeof).toBe(FORWARD_REF);
  return Icon.render(props, null);
}

describe("a Fluent-backed icon behaves like the lucide one it replaced", () => {
  it("passes className and size through", () => {
    const el = renderIcon("ChevronRight", { className: "size-4 text-primary", size: 16 });
    expect(el.props.className).toBe("size-4 text-primary");
    expect(el.props.width).toBe(16);
    expect(el.props.height).toBe(16);
  });

  it("defaults to 24px, which is the size lucide rendered at", () => {
    const el = renderIcon("Search");
    expect(el.props.width).toBe(24);
  });

  it("swallows strokeWidth instead of putting it on the svg", () => {
    // Seven files pass it. These glyphs are filled outlines with no stroke, so
    // the value means nothing — but spread onto the element it would both show
    // up in the DOM and, for `absoluteStrokeWidth`, draw a React warning about
    // an unknown attribute on every render.
    const el = renderIcon("RefreshCw", { strokeWidth: 1.5, absoluteStrokeWidth: true });
    expect(el.props.strokeWidth).toBeUndefined();
    expect(el.props.absoluteStrokeWidth).toBeUndefined();
  });

  it("keeps handlers and aria overrides the call site sets", () => {
    const onClick = () => {};
    const el = renderIcon("X", { onClick, "aria-hidden": false, "aria-label": "Close" });
    expect(el.props.onClick).toBe(onClick);
    expect(el.props["aria-hidden"]).toBe(false);
    expect(el.props["aria-label"]).toBe("Close");
  });

  it("draws in a 20px box, inheriting colour", () => {
    // Fluent's outlines are drawn for a 20px grid; re-boxing them to lucide's
    // 24 is what makes an icon set look soft next to its own labels.
    expect(ICON_VIEW_BOX).toBe("0 0 20 20");
    const el = renderIcon("Settings");
    expect(el.props.viewBox).toBe("0 0 20 20");
    expect(el.props.fill).toBe("currentColor");
  });

  it("has real path data for every glyph", () => {
    for (const name of FLUENT_NAMES) {
      const el = renderIcon(name);
      const children = el.props.children as Array<{ props: { d: string } }>;
      expect(children.length, name).toBeGreaterThan(0);
      for (const path of children) {
        expect(path.props.d.length, name).toBeGreaterThan(8);
        expect(path.props.d, name).toMatch(/^[Mm]/);
      }
    }
  });
});
