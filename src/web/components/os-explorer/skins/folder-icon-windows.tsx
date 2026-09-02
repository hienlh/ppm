/**
 * Hand-drawn Windows-11-flavoured folder glyphs (closed/open) — an original flat-yellow
 * rounded-rect with a tab, not a copy of Microsoft's proprietary folder artwork.
 */

import type { ComponentProps } from "react";

export function WindowsFolderIcon(props: ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path d="M3 7.5a1.5 1.5 0 0 1 1.5-1.5H10l1.6 2H19.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10Z" fill="#FFC93E" />
      <path d="M3 9.5h18v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-8Z" fill="#FFCE49" />
      <path d="M4 9.2h16" stroke="#FFFFFF" strokeOpacity=".35" strokeWidth="1" />
    </svg>
  );
}

export function WindowsFolderOpenIcon(props: ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path d="M3 7.5a1.5 1.5 0 0 1 1.5-1.5H10l1.6 2H19.5A1.5 1.5 0 0 1 21 9.5v.5H5.2a1.5 1.5 0 0 0-1.45 1.13L2 18.2V7.5Z" fill="#FFC93E" />
      <path d="M2.62 18.66 4.3 12.1A1.5 1.5 0 0 1 5.75 11H21l-1.86 6.63A1.5 1.5 0 0 1 17.7 18.7H4.06a1.5 1.5 0 0 1-1.44-1.9Z" fill="#FFB92E" />
    </svg>
  );
}
