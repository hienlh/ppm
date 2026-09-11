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

export function fluentIcon(name: string, paths: readonly string[]) {
  const Icon = forwardRef<SVGSVGElement, ProductIconProps>(function Icon(
    { size = 24, strokeWidth: _sw, absoluteStrokeWidth: _asw, ...rest },
    ref,
  ) {
    return (
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
      >
        {paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    );
  });
  Icon.displayName = name;
  return Icon;
}
