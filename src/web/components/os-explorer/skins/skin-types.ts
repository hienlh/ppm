/**
 * A skin is everything that makes the explorer window look native to a host OS: the
 * titlebar/toolbar chrome, the sidebar section names, and the folder glyph. Views, the
 * toolbar body and the sidebar rows themselves stay skin-agnostic — they read `vocab` and
 * the folder icon slot, nothing else changes.
 *
 * Colours are deliberately not part of this type: skin-specific CSS lives in `skins.css`
 * scoped under `[data-skin]`, reusing PPM's existing semantic tokens (`bg-panel`,
 * `text-text`, …) so both PPM dark and light modes fall out for free instead of needing a
 * second light/dark table here.
 */

import type { ComponentProps, FC } from "react";
import type { WindowChrome } from "@/components/floating-window/window-chrome-contract";

export type SkinId = "windows" | "macos";

/** Sidebar section labels that differ between a Windows and a Mac/Linux file manager. */
export interface SkinVocab {
  /** "Home" on both, kept explicit in case a future skin wants to drop it. */
  home: string;
  /** "Quick access" (Windows) vs "Favorites" (macOS). */
  pinned: string;
  /** "Folders" (Windows) vs "Locations" (macOS) — the known-folders section. */
  known: string;
  /** "Drives" (Windows) vs "Devices" (macOS) — rendered as its own section, so it needs a
   *  label distinct from `known` even though Finder visually groups both under Locations. */
  drives: string;
}

export type FolderIconComponent = FC<ComponentProps<"svg">>;

export interface ExplorerSkin {
  id: SkinId;
  vocab: SkinVocab;
  FolderIcon: FolderIconComponent;
  FolderOpenIcon: FolderIconComponent;
  /** Window titlebar/toolbar chrome for this skin. */
  chrome: WindowChrome;
}
