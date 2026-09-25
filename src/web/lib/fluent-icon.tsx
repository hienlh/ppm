/**
 * The one component every Fluent-backed product icon is built from.
 *
 * It has to be prop-compatible with lucide, because the swap is meant to be an
 * import-path change and nothing else: 233 files pass `className`, a handful
 * pass `strokeWidth`, and several hand the component itself to a slot typed
 * `ElementType`. So `size` is honoured, `strokeWidth` is accepted and dropped
 * (these glyphs are filled outlines — there is no stroke to weight), and the
 * ref goes through, since a few icons sit inside a Radix trigger.
 *
 * The glyphs are 20×20 where lucide's are 24×24. That is not a detail to
 * normalise away: Fluent's outlines are drawn *for* a 20px box, and scaling one
 * into a 24px viewBox is what makes an icon set look slightly soft next to its
 * own labels. The viewBox stays 20 and the rendered size is whatever the caller
 * asks for — which in this app is a Tailwind `size-*` class almost everywhere,
 * and those win over the width/height attributes because they are CSS.
 */
import { forwardRef, type SVGProps } from "react";
import { ICON_VIEW_BOX } from "./icons.generated";

export interface ProductIconProps extends Omit<SVGProps<SVGSVGElement>, "ref"> {
  /** Pixel size, for the few call sites that pass no `size-*` class. */
  size?: number | string;
  /** Accepted for lucide compatibility and ignored: these glyphs are filled. */
  strokeWidth?: number | string;
  absoluteStrokeWidth?: boolean;
}

export type ProductIcon = ReturnType<typeof fluentIcon>;

/**
 * Utilities that describe the box an icon occupies rather than the glyph drawn in
 * it: where it sits, its margins, how it behaves as a flex item — and the spin.
 */
const BOX_UTILITY =
  /^(?:animate-spin$|-?m[trblxyse]?-|absolute$|relative$|fixed$|sticky$|-?inset-|-?top-|-?right-|-?bottom-|-?left-|-?translate-|z-|shrink|grow|self-|order-|pointer-events-)/;

/**
 * A spinning icon's classes, split between a wrapping span and the svg — or null
 * when the icon does not spin.
 *
 * Chrome never hands an animation on an SVG element to the compositor, not even
 * on an outer `<svg>`, so `animate-spin` on one recalculates style and repaints on
 * the main thread every frame. Measured on a live tab, one spinner cost ~22% of a
 * core; the same glyph inside a spinning span cost nothing measurable. A running
 * tool card shows one for as long as the tool runs, which is most of a chat turn.
 *
 * The rotation moves to the span along with whatever positions the box, so a
 * margin sits outside the rotating box instead of pulling its centre off the
 * glyph, and an `absolute` spinner keeps its place. Size and colour stay on the
 * svg, which is what lets a parent's `[&_svg:not([class*='size-'])]` rule keep
 * sizing an icon that carries no size class of its own.
 */
export function splitSpinClasses(className: string): { box: string; glyph: string | undefined } | null {
  const tokens = className.split(/\s+/).filter(Boolean);
  const base = (t: string) => t.slice(t.lastIndexOf(":") + 1);
  if (!tokens.some((t) => base(t) === "animate-spin")) return null;
  const box = ["inline-flex"];
  const glyph: string[] = [];
  for (const t of tokens) (BOX_UTILITY.test(base(t)) ? box : glyph).push(t);
  return { box: box.join(" "), glyph: glyph.length ? glyph.join(" ") : undefined };
}

export function fluentIcon(name: string, paths: readonly string[]) {
  const Icon = forwardRef<SVGSVGElement, ProductIconProps>(function Icon(
    { size = 24, strokeWidth: _sw, absoluteStrokeWidth: _asw, className, ...rest },
    ref,
  ) {
    const spin = typeof className === "string" ? splitSpinClasses(className) : null;
    const svg = (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        viewBox={ICON_VIEW_BOX}
        width={size}
        height={size}
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
        // Which icon this is, readable from rendered markup and in devtools.
        // lucide put the same thing in a *class* (`lucide lucide-circle-check`),
        // which is why a test could assert a tool card was spinning by looking
        // for `lucide-loader-circle`. An attribute keeps that possible without
        // offering a class name for stylesheets to start depending on.
        data-icon={name}
        {...rest}
        className={spin ? spin.glyph : className}
      >
        {paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    );
    return spin ? <span className={spin.box}>{svg}</span> : svg;
  });
  Icon.displayName = name;
  return Icon;
}
