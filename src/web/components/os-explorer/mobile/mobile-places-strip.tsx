/**
 * Sidebar → horizontally scrollable "places" chip strip on mobile: PPM pins, the host's own
 * pinned folders, Home, and drives — condensed to fit under the title instead of a side
 * column. The full list (known folders included) lives in a "Places" sheet behind the last
 * chip.
 *
 * `touch-pan-x` keeps the browser's native scroll-chaining to the horizontal axis only, so a
 * drag that starts on a chip does not also read as a vertical page scroll.
 */

import { useState, type ComponentType } from "react";
import { HardDrive, MoreHorizontal, Network, Pin, Usb } from "@/lib/icons";
import type { Drive, HostInfo } from "../../../../types/system";
import { cn } from "@/lib/utils";
import { useExplorerPinsStore } from "../explorer-pins-store";
import { FileTypeIcon } from "../icons/file-type-icon";
import type { SkinVocab } from "../skins/skin-types";
import { MobilePlacesSheet } from "./mobile-places-sheet";
import { labelPlaces } from "../place-labels";
import { MOBILE_EXPLORER_CHIP } from "./mobile-explorer-chip";

function FolderChipIcon({ className }: { className?: string }) {
  return <FileTypeIcon name="" kind="directory" className={className} />;
}

const DRIVE_ICON: Record<Drive["kind"], ComponentType<{ className?: string }>> = {
  fixed: HardDrive,
  removable: Usb,
  network: Network,
  unknown: HardDrive,
};

interface Chip {
  key: string;
  label: string;
  path: string;
  icon: ComponentType<{ className?: string }>;
}

function Chip({ chip, active, onNavigate }: { chip: Chip; active: boolean; onNavigate(path: string): void }) {
  const Icon = chip.icon;
  return (
    <button
      type="button"
      onClick={() => onNavigate(chip.path)}
      title={chip.path}
      className={cn(
        MOBILE_EXPLORER_CHIP,
        active ? "border-primary bg-accent-wash text-text" : "border-border text-text-2",
      )}
    >
      <Icon className="text-text-subtle" />
      <span className="max-w-[10rem] truncate">{chip.label}</span>
    </button>
  );
}

export interface MobilePlacesStripProps {
  host: HostInfo | null;
  currentPath: string;
  onNavigate(path: string): void;
  vocab: SkinVocab;
}

export function MobilePlacesStrip({ host, currentPath, onNavigate, vocab }: MobilePlacesStripProps) {
  const pins = useExplorerPinsStore((s) => s.pins);
  const [placesOpen, setPlacesOpen] = useState(false);

  // PPM pins and the OS's own pins in one list, so a folder pinned in both is one chip and two
  // folders sharing a name ("Projects" on C: and on D:) say where each one is.
  const pinned = labelPlaces(
    [
      ...pins.map((pin) => ({ name: pin.name, path: pin.path, ppm: true })),
      ...(host?.pinned.map((p) => ({ name: p.name, path: p.path, ppm: false })) ?? []),
    ],
    host?.homedir ?? null,
  );
  const chips: Chip[] = [
    ...pinned.filter((p) => p.ppm).map((p): Chip => ({ key: `pin:${p.path}`, label: p.label, path: p.path, icon: Pin })),
    ...(host ? [{ key: "home", label: vocab.home, path: host.homedir, icon: FolderChipIcon }] : []),
    ...pinned.filter((p) => !p.ppm).map((p): Chip => ({ key: `os:${p.path}`, label: p.label, path: p.path, icon: FolderChipIcon })),
    ...(host?.drives.map((d): Chip => ({
      key: `drive:${d.path}`,
      label: d.label ? `${d.label} (${d.name})` : d.name,
      path: d.path,
      icon: DRIVE_ICON[d.kind],
    })) ?? []),
  ];

  return (
    <>
      <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto touch-pan-x border-b border-border px-2 py-1.5" data-testid="explorer-places-strip">
        {chips.map((chip) => (
          <Chip key={chip.key} chip={chip} active={chip.path === currentPath} onNavigate={onNavigate} />
        ))}
        <button
          type="button"
          aria-label="All places"
          title="All places"
          onClick={() => setPlacesOpen(true)}
          className={cn(MOBILE_EXPLORER_CHIP, "border-border text-text-2")}
        >
          <MoreHorizontal />
        </button>
      </div>

      <MobilePlacesSheet
        open={placesOpen}
        onClose={() => setPlacesOpen(false)}
        host={host}
        currentPath={currentPath}
        vocab={vocab}
        onNavigate={(path) => {
          setPlacesOpen(false);
          onNavigate(path);
        }}
      />
    </>
  );
}
