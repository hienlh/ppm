/**
 * Full places list behind the chip strip's "All places" chip: PPM pins, OS pinned folders,
 * known folders and drives, each sectioned exactly like the desktop sidebar — the strip only
 * condenses the *common case*, this sheet is where everything still lives.
 */

import type { ReactNode } from "react";
import { HardDrive, Network, Pin, Usb } from "lucide-react";
import type { Drive, HostInfo } from "../../../../types/system";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { useExplorerPinsStore } from "../explorer-pins-store";
import { FileTypeIcon } from "../icons/file-type-icon";
import type { SkinVocab } from "../skins/skin-types";
import { cn } from "@/lib/utils";

const ICON_CLASS = "size-4 shrink-0 text-text-subtle";
const DRIVE_ICON: Record<Drive["kind"], typeof HardDrive> = {
  fixed: HardDrive,
  removable: Usb,
  network: Network,
  unknown: HardDrive,
};

/** Folder-type place rows draw the current skin's folder glyph, same as the desktop sidebar. */
function folderIcon(): ReactNode {
  return <FileTypeIcon name="" kind="directory" className={ICON_CLASS} />;
}

function Row({
  label, path, active, icon, onNavigate,
}: {
  label: string; path: string; active: boolean; icon: ReactNode; onNavigate(path: string): void;
}) {
  return (
    <button
      type="button"
      title={path}
      onClick={() => onNavigate(path)}
      className={cn(
        "flex min-h-[44px] w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm active:bg-surface-elevated",
        active ? "bg-accent-wash text-text" : "text-text-2",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="pb-2">
      <p className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">{title}</p>
      {children}
    </div>
  );
}

export interface MobilePlacesSheetProps {
  open: boolean;
  onClose(): void;
  host: HostInfo | null;
  currentPath: string;
  vocab: SkinVocab;
  onNavigate(path: string): void;
}

export function MobilePlacesSheet({ open, onClose, host, currentPath, vocab, onNavigate }: MobilePlacesSheetProps) {
  const pins = useExplorerPinsStore((s) => s.pins);
  const isActive = (path: string) => path === currentPath;

  return (
    <BottomSheet open={open} onClose={onClose} zIndex={65} className="p-1">
      <div className="max-h-[70vh] overflow-y-auto px-1 pb-2">
        {pins.length > 0 && (
          <Section title="Pinned">
            {pins.map((pin) => (
              <Row key={pin.path} label={pin.name} path={pin.path} icon={<Pin className={ICON_CLASS} />} active={isActive(pin.path)} onNavigate={onNavigate} />
            ))}
          </Section>
        )}

        {host && host.pinned.length > 0 && (
          <Section title={vocab.pinned}>
            {host.pinned.map((entry) => (
              <Row key={entry.path} label={entry.name} path={entry.path} icon={folderIcon()} active={isActive(entry.path)} onNavigate={onNavigate} />
            ))}
          </Section>
        )}

        {host && (
          <Section title={vocab.known}>
            <Row label={vocab.home} path={host.homedir} icon={folderIcon()} active={isActive(host.homedir)} onNavigate={onNavigate} />
            {host.knownFolders.map((folder) => (
              <Row key={folder.path} label={folder.name} path={folder.path} icon={folderIcon()} active={isActive(folder.path)} onNavigate={onNavigate} />
            ))}
          </Section>
        )}

        {host && host.drives.length > 0 && (
          <Section title={vocab.drives}>
            {host.drives.map((drive) => {
              const DriveIcon = DRIVE_ICON[drive.kind];
              return (
                <Row
                  key={drive.path}
                  label={drive.label ? `${drive.label} (${drive.name})` : drive.name}
                  path={drive.path}
                  icon={<DriveIcon className={ICON_CLASS} />}
                  active={isActive(drive.path)}
                  onNavigate={onNavigate}
                />
              );
            })}
          </Section>
        )}
      </div>
    </BottomSheet>
  );
}
