import { useEffect, type ElementType } from "react";
import { Download, ExternalLink, FileArchive, FileCode, Loader2, Presentation, Printer } from "@/lib/icons";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { NEW_TAB_REL } from "@/lib/design/design-export-client";
import type { DesignExportFeature, DesignExportJob } from "./use-design-export";

/**
 * The Export menu: a dropdown on desktop, a bottom sheet of 44px rows on a phone, both built
 * from {@link exportEntries}.
 *
 * PDF and "Open in new tab" are real links (`target=_blank`, `rel="noopener noreferrer"`) to
 * the view tokens minted when the menu opened, so the user's own click opens them: no popup
 * blocker is involved, and the new tab has no handle on PPM. Until the tokens arrive those
 * two rows are disabled.
 */

interface ExportEntry {
  id: string;
  label: string;
  icon: ElementType;
  job?: DesignExportJob;
  /** A link row when set (null while its token is being minted). */
  href?: string | null;
  run?: () => void;
}

function exportEntries(f: DesignExportFeature): ExportEntry[] {
  const entries: ExportEntry[] = [
    { id: "zip", label: "Download ZIP", icon: FileArchive, job: "zip", run: f.downloadZip },
    { id: "html", label: "Download HTML file", icon: FileCode, job: "html", run: f.downloadHtml },
    { id: "pdf", label: "Print or save as PDF", icon: Printer, href: f.views.print },
  ];
  if (f.canPptx) entries.push({ id: "pptx", label: "Download PowerPoint", icon: Presentation, job: "pptx", run: f.exportPptx });
  entries.push({ id: "tab", label: "Open in new tab", icon: ExternalLink, href: f.views.standalone });
  return entries;
}

function EntryIcon({ entry, busy, className }: { entry: ExportEntry; busy: DesignExportJob | null; className: string }) {
  if (entry.job && busy === entry.job) return <Loader2 className={cn(className, "animate-spin")} />;
  return <entry.icon className={className} />;
}

/** Desktop: the toolbar's Export button and its dropdown. */
export function ExportMenuButton({ feature, className }: { feature: DesignExportFeature; className?: string }) {
  return (
    <DropdownMenu onOpenChange={(open) => { if (open) feature.prepare(); }}>
      <DropdownMenuTrigger asChild>
        <button type="button" className={className} aria-label="Export" title="Export">
          {feature.busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel className="text-xs text-text-subtle">Export</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {exportEntries(feature).map((entry) => (entry.href !== undefined ? (
          <DropdownMenuItem key={entry.id} asChild disabled={!entry.href}>
            <a href={entry.href ?? undefined} target="_blank" rel={NEW_TAB_REL}>
              <EntryIcon entry={entry} busy={feature.busy} className="size-4" /> {entry.label}
              {!entry.href && <span className="ml-auto text-xs text-text-subtle">Preparing…</span>}
            </a>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem key={entry.id} disabled={!!feature.busy} onSelect={() => entry.run?.()}>
            <EntryIcon entry={entry} busy={feature.busy} className="size-4" /> {entry.label}
          </DropdownMenuItem>
        )))}
        {feature.viewError && <p className="px-2 py-1.5 text-xs text-destructive" role="alert">{feature.viewError}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Phone: the same entries as a bottom sheet, opened from the More sheet's Export row. */
export function ExportSheet({ feature }: { feature: DesignExportFeature }) {
  const { sheetOpen, prepare, setSheetOpen } = feature;
  useEffect(() => { if (sheetOpen) prepare(); }, [sheetOpen, prepare]);
  const close = () => setSheetOpen(false);
  const row = "flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm hover:bg-surface-elevated";
  return (
    <BottomSheet open={sheetOpen} onClose={close}>
      <div className="flex flex-col gap-1 px-2 pb-2">
        <p className="px-3 pt-1 text-xs font-semibold uppercase tracking-wide text-text-subtle">Export</p>
        {exportEntries(feature).map((entry) => (entry.href !== undefined ? (
          entry.href ? (
            <a key={entry.id} href={entry.href} target="_blank" rel={NEW_TAB_REL} className={row} onClick={close}>
              <EntryIcon entry={entry} busy={feature.busy} className="size-5 text-text-subtle" /> <span className="flex-1">{entry.label}</span>
            </a>
          ) : (
            <div key={entry.id} className={cn(row, "opacity-40")} aria-disabled="true">
              <EntryIcon entry={entry} busy={feature.busy} className="size-5 text-text-subtle" />
              <span className="flex-1">{entry.label}</span><span className="text-xs text-text-subtle">Preparing…</span>
            </div>
          )
        ) : (
          <button key={entry.id} type="button" className={cn(row, "disabled:opacity-40")} disabled={!!feature.busy}
            onClick={() => { close(); entry.run?.(); }}>
            <EntryIcon entry={entry} busy={feature.busy} className="size-5 text-text-subtle" /> <span className="flex-1">{entry.label}</span>
          </button>
        )))}
        {feature.viewError && <p className="px-3 py-1 text-xs text-destructive" role="alert">{feature.viewError}</p>}
      </div>
    </BottomSheet>
  );
}
