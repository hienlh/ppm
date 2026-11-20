import { TEXT_CONTROL_HEIGHT } from "@/lib/control-size";

/**
 * One chip shape for the phone sheet's two chip rows — the path (breadcrumb) and the places —
 * at the app's chip height (`control-size.ts`: 28px, 26px below `md`) with the footer chips'
 * text and icon sizes. Colours are left to the caller: a place chip marks the folder on screen,
 * a path chip marks the last segment.
 */
export const MOBILE_EXPLORER_CHIP =
  `${TEXT_CONTROL_HEIGHT} flex shrink-0 items-center gap-1 rounded-full border px-2.5 max-md:px-2 ` +
  "text-[11.5px] whitespace-nowrap active:bg-surface-elevated [&_svg]:size-3.5 [&_svg]:shrink-0";
