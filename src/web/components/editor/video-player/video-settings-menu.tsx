import { FlipHorizontal2, FlipVertical2, RotateCcw, RotateCw, Settings, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isIdentity, type VideoTransform } from "./video-transform";
import { VIDEO_SHORTCUTS } from "./use-video-keyboard-shortcuts";

export const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

interface Props {
  speed: number;
  onSpeed: (rate: number) => void;
  transform: VideoTransform;
  onRotate: (direction: 1 | -1) => void;
  onFlipH: () => void;
  onFlipV: () => void;
  onResetTransform: () => void;
}

/** Gear menu: playback speed, orientation fixes, and the shortcut cheat-sheet. */
export function VideoSettingsMenu({ speed, onSpeed, transform, onRotate, onFlipH, onFlipV, onResetTransform }: Props) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-11 shrink-0 relative" aria-label="Playback settings">
          <Settings className="size-5" />
          {speed !== 1 && (
            <span className="absolute -top-0.5 -right-0.5 text-[10px] leading-none px-1 rounded bg-primary text-primary-foreground tabular-nums">
              {speed}x
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      {/* Flat list on purpose: sub-menus are awkward on touch screens. */}
      <DropdownMenuContent align="end" className="w-60 max-h-[70vh] overflow-y-auto">
        <DropdownMenuLabel>Speed</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={String(speed)} onValueChange={(v) => onSpeed(Number(v))}>
          <div className="grid grid-cols-4 gap-1 px-1 pb-1">
            {SPEED_STEPS.map((s) => (
              <DropdownMenuRadioItem
                key={s}
                value={String(s)}
                className="justify-center pl-2 min-h-11 text-xs tabular-nums data-[state=checked]:bg-accent [&>span:first-child]:hidden"
              >
                {s}x
              </DropdownMenuRadioItem>
            ))}
          </div>
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />
        <DropdownMenuLabel>Orientation</DropdownMenuLabel>
        <DropdownMenuItem className="min-h-11" onSelect={(e) => { e.preventDefault(); onRotate(1); }}>
          <RotateCw className="size-4" /> Rotate right <span className="ml-auto text-xs text-text-subtle">R</span>
        </DropdownMenuItem>
        <DropdownMenuItem className="min-h-11" onSelect={(e) => { e.preventDefault(); onRotate(-1); }}>
          <RotateCcw className="size-4" /> Rotate left <span className="ml-auto text-xs text-text-subtle">⇧R</span>
        </DropdownMenuItem>
        <DropdownMenuItem className="min-h-11" onSelect={(e) => { e.preventDefault(); onFlipH(); }}>
          <FlipHorizontal2 className="size-4" /> Flip horizontal {transform.flipH && <span className="ml-auto text-xs">✓</span>}
        </DropdownMenuItem>
        <DropdownMenuItem className="min-h-11" onSelect={(e) => { e.preventDefault(); onFlipV(); }}>
          <FlipVertical2 className="size-4" /> Flip vertical {transform.flipV && <span className="ml-auto text-xs">✓</span>}
        </DropdownMenuItem>
        {!isIdentity(transform) && (
          <DropdownMenuItem className="min-h-11" onSelect={onResetTransform}>
            <Undo2 className="size-4" /> Reset orientation
          </DropdownMenuItem>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuLabel>Keyboard</DropdownMenuLabel>
        <div className="px-2 pb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-text-secondary">
          {VIDEO_SHORTCUTS.map(([keys, action]) => (
            <div key={keys} className="contents">
              <kbd className="font-mono text-text-subtle whitespace-nowrap">{keys}</kbd>
              <span>{action}</span>
            </div>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
