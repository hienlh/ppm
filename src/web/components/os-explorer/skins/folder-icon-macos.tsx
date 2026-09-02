/**
 * Hand-drawn Finder-flavoured folder glyphs (closed/open) — an original blue-gradient
 * rounded folder, not a copy of Apple's proprietary folder artwork.
 *
 * Gradient ids are per-instance (`useId`) since a folder-heavy listing renders dozens of
 * these at once — a hardcoded id would make every icon after the first reuse the first
 * instance's `<linearGradient>` (SVG `url(#id)` resolves to the first match in the DOM).
 */

import { useId, type ComponentProps } from "react";

export function MacFolderIcon(props: ComponentProps<"svg">) {
  const gradientId = `mac-folder-${useId()}`;
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7FC1FF" />
          <stop offset="1" stopColor="#3E92E5" />
        </linearGradient>
      </defs>
      <path d="M2.5 8a2 2 0 0 1 2-2h5.2l1.7 2H19.5a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2V8Z" fill={`url(#${gradientId})`} />
      <path d="M2.5 10.5h19V9.8H4.7A2 2 0 0 0 2.5 10.5Z" fill="#FFFFFF" fillOpacity=".3" />
    </svg>
  );
}

export function MacFolderOpenIcon(props: ComponentProps<"svg">) {
  const gradientId = `mac-folder-open-${useId()}`;
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8FCBFF" />
          <stop offset="1" stopColor="#2F82D9" />
        </linearGradient>
      </defs>
      <path d="M2.5 8a2 2 0 0 1 2-2h5.2l1.7 2H19.5a2 2 0 0 1 2 2v.3H5.9a2 2 0 0 0-1.94 1.51L2.5 17.9V8Z" fill="#7FC1FF" />
      <path d="M2.13 18.36 3.98 11.1A2 2 0 0 1 5.92 9.6H21l-2.16 8a2 2 0 0 1-1.93 1.48H4.06a2 2 0 0 1-1.93-2.52Z" fill={`url(#${gradientId})`} />
    </svg>
  );
}
