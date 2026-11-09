import type { ElementType } from "react";
import { Layers, MessageSquare, MessageSquarePlus, Monitor, PanelRight, Presentation, Smartphone, Tablet, X } from "@/lib/icons";
import type { DesignVariant } from "../../shared/design-variants";
import { DEVICE_FRAMES, type DeviceFrameId } from "../components/design/canvas/device-frame-presets";
import { buttonQuiet, buttonToggleOn, cx } from "./share-ui";

/**
 * The reviewer's controls. From `md` a toolbar above the design: variants, device frames,
 * Comment and the comments panel. On a phone the same actions sit in a bar at the bottom,
 * in the thumb zone; there is no device frame there, the phone is the frame.
 */

const FRAME_ICONS: Record<DeviceFrameId, ElementType> = { desktop: Monitor, tablet: Tablet, phone: Smartphone, slide: Presentation };

export const variantLabel = (v: DesignVariant, i: number): string => v.label || `Variant ${i + 1}`;

/** A native select: the platform's own picker on a phone, no custom dropdown to get wrong. */
export function VariantPicker({ variants, file, onChange, compact }: {
  variants: DesignVariant[];
  file: string;
  onChange: (file: string) => void;
  compact?: boolean;
}) {
  if (variants.length < 2) return null;
  return (
    <label className={cx("relative flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-text-2 active:bg-panel-2 can-hover:hover:bg-panel-2",
      compact && "flex-col justify-center gap-0.5 px-2 text-xs")}>
      <Layers className={compact ? "size-5" : "size-4"} aria-hidden="true" />
      <span className={compact ? undefined : "sr-only"}>Variants</span>
      <select value={file} onChange={(e) => onChange(e.target.value)} aria-label="Variant"
        className={cx("bg-transparent text-sm text-text", compact && "absolute inset-0 opacity-0")}>
        {variants.map((v, i) => <option key={v.file} value={v.file}>{variantLabel(v, i)}</option>)}
      </select>
    </label>
  );
}

export function ShareToolbar({ title, subtitle, variants, file, onVariant, frame, onFrame, picking, onPicking, panelOpen, onPanel, count }: {
  title: string;
  subtitle: string;
  variants: DesignVariant[];
  file: string;
  onVariant: (file: string) => void;
  frame: DeviceFrameId;
  onFrame: (frame: DeviceFrameId) => void;
  picking: boolean;
  onPicking: (on: boolean) => void;
  panelOpen: boolean;
  onPanel: (open: boolean) => void;
  count: number;
}) {
  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-border bg-panel px-3 py-1">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-semibold">{title}</h1>
        <p className="truncate text-xs text-text-3">{subtitle}</p>
      </div>
      <VariantPicker variants={variants} file={file} onChange={onVariant} />
      <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5" role="group" aria-label="Device frame">
        {DEVICE_FRAMES.map((f) => {
          const Icon = FRAME_ICONS[f.id];
          return (
            <button key={f.id} type="button" title={f.label} aria-label={f.label} aria-pressed={frame === f.id}
              className={cx(buttonQuiet, "px-2", frame === f.id && buttonToggleOn)} onClick={() => onFrame(f.id)}>
              <Icon className="size-4" />
            </button>
          );
        })}
      </div>
      <button type="button" aria-pressed={picking} onClick={() => onPicking(!picking)}
        className={cx(buttonQuiet, picking && buttonToggleOn)}>
        <MessageSquarePlus className="size-4" /> {picking ? "Choosing…" : "Comment"}
      </button>
      <button type="button" aria-pressed={panelOpen} onClick={() => onPanel(!panelOpen)}
        className={cx(buttonQuiet, panelOpen && buttonToggleOn)} aria-label={`Comments (${count})`}>
        <PanelRight className="size-4" /> {count}
      </button>
    </header>
  );
}

export function ShareBottomBar({ variants, file, onVariant, picking, onPicking, onComments, count }: {
  variants: DesignVariant[];
  file: string;
  onVariant: (file: string) => void;
  picking: boolean;
  onPicking: (on: boolean) => void;
  onComments: () => void;
  count: number;
}) {
  const cell = "flex min-h-12 min-w-16 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg text-xs font-medium text-text-2 active:bg-panel-2";
  return (
    <nav className="flex shrink-0 items-stretch gap-2 border-t border-border bg-panel px-2 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))]" aria-label="Review">
      <button type="button" aria-pressed={picking} onClick={() => onPicking(!picking)} className={cx(cell, picking && "text-primary")}>
        {picking ? <X className="size-5" /> : <MessageSquarePlus className="size-5" />} {picking ? "Done" : "Comment"}
      </button>
      <button type="button" onClick={onComments} className={cell}>
        <MessageSquare className="size-5" /> Comments ({count})
      </button>
      {variants.length > 1 && (
        <div className="flex flex-1"><VariantPicker variants={variants} file={file} onChange={onVariant} compact /></div>
      )}
    </nav>
  );
}
