/**
 * Touch key row for the terminal: clipboard actions plus the keys a soft
 * keyboard does not offer (Tab, Esc, Ctrl, arrows, ^C).
 *
 * The row scrolls horizontally — 44px targets for eleven controls cannot fit a
 * phone's width — so it carries an edge fade to advertise that there is more
 * past the right edge. Without it the last keys look absent rather than
 * off-screen.
 */
import { Copy, ClipboardPaste, MessageSquare, Link, TextSelect } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MobileKey {
  label: string;
  value: string | null;
}

export const MOBILE_KEYS: readonly MobileKey[] = [
  { label: "Tab", value: "\t" },
  { label: "Esc", value: "\x1b" },
  { label: "Ctrl", value: null },
  { label: "↑", value: "\x1b[A" },
  { label: "↓", value: "\x1b[B" },
  { label: "←", value: "\x1b[D" },
  { label: "→", value: "\x1b[C" },
  { label: "^C", value: "\x03" },
];

const BUTTON_BASE =
  "flex items-center justify-center shrink-0 min-w-11 min-h-11 rounded text-xs " +
  "bg-surface-elevated text-text-primary active:bg-primary active:text-primary-foreground " +
  "transition-colors select-none";

interface TerminalMobileToolbarProps {
  ctrlMode: boolean;
  onToggleCtrl: () => void;
  selectMode: boolean;
  onToggleSelect: () => void;
  onKey: (value: string) => void;
  onCopy: () => void;
  onPaste: () => void;
  onSendToChat: () => void;
  onOpenLinks: () => void;
}

export function TerminalMobileToolbar({
  ctrlMode,
  onToggleCtrl,
  selectMode,
  onToggleSelect,
  onKey,
  onCopy,
  onPaste,
  onSendToChat,
  onOpenLinks,
}: TerminalMobileToolbarProps) {
  return (
    <div className="relative shrink-0 bg-surface border-t border-border">
      <div className="flex items-center gap-1 px-2 py-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button
          onClick={onToggleSelect}
          aria-label="Select text"
          aria-pressed={selectMode}
          className={cn(BUTTON_BASE, selectMode && "bg-primary text-primary-foreground")}
        >
          <TextSelect size={16} />
        </button>
        <button onClick={onCopy} aria-label="Copy" className={BUTTON_BASE}>
          <Copy size={16} />
        </button>
        <button onClick={onPaste} aria-label="Paste" className={BUTTON_BASE}>
          <ClipboardPaste size={16} />
        </button>
        <button onClick={onOpenLinks} aria-label="Links" className={BUTTON_BASE}>
          <Link size={16} />
        </button>
        <button onClick={onSendToChat} aria-label="Send to Chat" className={BUTTON_BASE}>
          <MessageSquare size={16} />
        </button>

        <div className="w-px h-6 shrink-0 bg-border mx-0.5" />

        {MOBILE_KEYS.map((key) => (
          <button
            key={key.label}
            onClick={() => (key.value === null ? onToggleCtrl() : onKey(key.value))}
            className={cn(
              BUTTON_BASE,
              "font-mono",
              key.value === null && ctrlMode && "bg-primary text-primary-foreground",
            )}
          >
            {key.label}
          </button>
        ))}

        {/* Trailing spacer so the last key clears the fade instead of hiding under it. */}
        <div className="w-6 shrink-0" aria-hidden />
      </div>

      <div
        className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-surface to-transparent"
        aria-hidden
      />
    </div>
  );
}
