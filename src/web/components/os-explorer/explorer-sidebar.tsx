/**
 * Places sidebar: PPM pins, the OS's own pinned folders, the known folders, and the
 * drives.
 *
 * Host-info provider failures arrive as `warnings[]` rather than as an error — a Mac
 * without Full Disk Access still has drives and known folders — so they render as a muted
 * hint row instead of replacing the sidebar.
 */

import type { ComponentType } from "react";
import { AlertTriangle, HardDrive, Pin, Usb, Network } from "lucide-react";
import type { HostInfo, Drive } from "../../../types/system";
import { cn } from "@/lib/utils";
import { DROP_TARGET_CLASS } from "./dnd/drop-target-style";
import type { DropRunner } from "./dnd/entry-drop-executor";
import { usePathDropTarget } from "./dnd/use-path-drop-target";
import { useDropTransfer } from "./dnd/use-drop-transfer";
import { useExplorerPinsStore } from "./explorer-pins-store";
import { FileTypeIcon } from "./icons/file-type-icon";
import type { SkinVocab } from "./skins/skin-types";
import { usePrefersCoarsePointer } from "./use-coarse-long-press";

/** A folder-type place row draws the current skin's folder glyph via `FileTypeIcon`'s context. */
function FolderPlaceIcon({ className }: { className?: string }) {
  return <FileTypeIcon name="" kind="directory" className={cn("size-4 shrink-0", className)} />;
}

const DRIVE_ICON: Record<Drive["kind"], typeof HardDrive> = {
  fixed: HardDrive,
  removable: Usb,
  network: Network,
  unknown: HardDrive,
};

type PlaceIcon = ComponentType<{ className?: string }>;

interface PlaceProps {
  label: string;
  path: string;
  active: boolean;
  icon: PlaceIcon;
  onNavigate(path: string): void;
  onUnpin?(): void;
  /** Every place is a directory, so a drop always has somewhere valid to land. */
  run: DropRunner;
}

function Place({ label, path, active, icon: Icon, onNavigate, onUnpin, run }: PlaceProps) {
  // Gated on real pointer coarseness, not a `md:` breakpoint — an iPad is ≥768px but has no
  // mouse, so a breakpoint-only rule was silently dropping the 44px minimum for it.
  const coarse = usePrefersCoarsePointer();
  const drop = usePathDropTarget({ targetDir: path, run });
  return (
    <div className="group/place relative flex items-center">
      <button
        type="button"
        title={path}
        onClick={() => onNavigate(path)}
        className={cn(
          "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px]",
          coarse ? "min-h-[44px]" : "min-h-0",
          "can-hover:hover:bg-surface-elevated",
          active ? "bg-accent-wash text-text" : "text-text-2",
          drop.isOver && DROP_TARGET_CLASS,
        )}
        {...drop.handlers}
      >
        <Icon className="size-4 shrink-0 text-text-subtle" />
        <span className="truncate">{label}</span>
      </button>
      {onUnpin && (
        <button
          type="button"
          aria-label={`Unpin ${label}`}
          title="Unpin"
          onClick={onUnpin}
          // Always reachable on touch; only revealed on hover where hovering exists.
          className="absolute right-1 rounded p-1 text-text-subtle can-hover:opacity-0 can-hover:group-hover/place:opacity-100 can-hover:hover:text-text"
        >
          <Pin className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pb-2">
      <p className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
        {title}
      </p>
      {children}
    </div>
  );
}

/** Used when a caller renders the sidebar without a resolved skin (defensive default). */
const DEFAULT_VOCAB: SkinVocab = { home: "Home", pinned: "Quick access", known: "Folders", drives: "Drives" };

export interface ExplorerSidebarProps {
  host: HostInfo | null;
  currentPath: string;
  onNavigate(path: string): void;
  /** Section labels for the current OS skin — Finder says "Favorites"/"Locations". */
  vocab?: SkinVocab;
}

export function ExplorerSidebar({ host, currentPath, onNavigate, vocab = DEFAULT_VOCAB }: ExplorerSidebarProps) {
  const pins = useExplorerPinsStore((s) => s.pins);
  const unpin = useExplorerPinsStore((s) => s.unpin);
  const isActive = (path: string) => path === currentPath;
  // One drop-transfer context for the whole sidebar — every place lands through the same
  // collision prompt rather than each row owning its own dialog state.
  const { run, prompts } = useDropTransfer(host?.sep ?? "/", host?.platform);

  return (
    <aside
      aria-label="Places"
      data-testid="explorer-sidebar"
      className="hidden w-44 shrink-0 overflow-y-auto border-r border-border bg-[var(--x-sidebar-bg,var(--panel-2))] px-1 py-1 sm:block"
    >
      {pins.length > 0 && (
        <Section title="Pinned">
          {pins.map((pin) => (
            <Place
              key={pin.path}
              label={pin.name}
              path={pin.path}
              icon={Pin}
              active={isActive(pin.path)}
              onNavigate={onNavigate}
              onUnpin={() => unpin(pin.path)}
              run={run}
            />
          ))}
        </Section>
      )}

      {host && host.pinned.length > 0 && (
        <Section title={vocab.pinned}>
          {host.pinned.map((entry) => (
            <Place
              key={entry.path}
              label={entry.name}
              path={entry.path}
              icon={FolderPlaceIcon}
              active={isActive(entry.path)}
              onNavigate={onNavigate}
              run={run}
            />
          ))}
        </Section>
      )}

      {host && (
        <Section title={vocab.known}>
          <Place label={vocab.home} path={host.homedir} icon={FolderPlaceIcon} active={isActive(host.homedir)} onNavigate={onNavigate} run={run} />
          {host.knownFolders.map((folder) => (
            <Place
              key={folder.path}
              label={folder.name}
              path={folder.path}
              icon={FolderPlaceIcon}
              active={isActive(folder.path)}
              onNavigate={onNavigate}
              run={run}
            />
          ))}
        </Section>
      )}

      {host && host.drives.length > 0 && (
        <Section title={vocab.drives}>
          {host.drives.map((drive) => (
            <Place
              key={drive.path}
              label={drive.label ? `${drive.label} (${drive.name})` : drive.name}
              path={drive.path}
              icon={DRIVE_ICON[drive.kind]}
              active={isActive(drive.path)}
              onNavigate={onNavigate}
              run={run}
            />
          ))}
        </Section>
      )}

      {host?.warnings.map((warning) => (
        <p key={warning} className="flex gap-1.5 px-2 py-1 text-[11px] leading-snug text-text-subtle">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span>{warning}</span>
        </p>
      ))}
      {prompts}
    </aside>
  );
}
