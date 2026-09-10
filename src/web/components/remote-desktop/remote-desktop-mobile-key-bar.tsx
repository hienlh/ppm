/**
 * Compact function/combo key row shown above the toolbar while the virtual keyboard is open.
 * Modifiers (Ctrl/Alt/Shift/Win) are STICKY: tap to hold (sends the key-down immediately,
 * highlights the button), tap again to release (key-down was already sent, so this just sends
 * the matching key-up) — lets a chord like "Ctrl + tap on the video" be built one tap at a time.
 * The combo buttons (Ctrl+C etc.) are a shortcut for the same idea: one tap sends the whole
 * down/up sequence, independent of whatever sticky modifiers happen to be held.
 *
 * No server changes needed — every button here is just the existing `{type:"key",code,down}`
 * protocol `use-remote-input-capture.ts` already speaks; the server's own `heldKeyCodes`
 * tracking (`remote-desktop-session.ts`) already releases anything sent down:true here too on
 * disconnect/heartbeat-timeout, the same as a real held key.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface RemoteDesktopMobileKeyBarProps {
  sendMessage: (msg: Record<string, unknown>) => void;
}

const MODIFIERS = [
  { label: "Ctrl", code: "ControlLeft" },
  { label: "Alt", code: "AltLeft" },
  { label: "Shift", code: "ShiftLeft" },
  { label: "Win", code: "MetaLeft" },
] as const;

const FUNCTION_KEYS = [
  { label: "Esc", code: "Escape" },
  { label: "Tab", code: "Tab" },
  { label: "←", code: "ArrowLeft" },
  { label: "↑", code: "ArrowUp" },
  { label: "↓", code: "ArrowDown" },
  { label: "→", code: "ArrowRight" },
] as const;

const COMBOS: readonly { label: string; codes: readonly string[] }[] = [
  { label: "Ctrl+C", codes: ["ControlLeft", "KeyC"] },
  { label: "Ctrl+V", codes: ["ControlLeft", "KeyV"] },
  { label: "Ctrl+Z", codes: ["ControlLeft", "KeyZ"] },
  { label: "Ctrl+A", codes: ["ControlLeft", "KeyA"] },
  { label: "Alt+Tab", codes: ["AltLeft", "Tab"] },
  // Windows blocks synthetic Ctrl+Alt+Del (the Secure Attention Sequence) from SendInput
  // regardless of privilege level — this is an OS restriction, not a bug here. The button is
  // best-effort: harmless to try, and there is no way to detect the block ahead of time.
  { label: "Ctrl+Alt+Del", codes: ["ControlLeft", "AltLeft", "Delete"] },
];

function KeyBarButton({
  onClick,
  active,
  className,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "min-h-11 min-w-11 shrink-0 whitespace-nowrap rounded-md px-2.5 text-xs font-medium text-white/80",
        "active:bg-white/15 transition-colors",
        active && "bg-primary text-primary-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function RemoteDesktopMobileKeyBar({ sendMessage }: RemoteDesktopMobileKeyBarProps) {
  const [held, setHeld] = useState<ReadonlySet<string>>(new Set());
  const heldRef = useRef(held);
  heldRef.current = held;

  // Safety net: a modifier left toggled on must not stay logically held on the host once this
  // bar goes away (keyboard dismissed, sheet closed) — same reasoning as `releaseAll` elsewhere.
  useEffect(() => {
    return () => {
      heldRef.current.forEach((code) => sendMessage({ type: "key", code, down: false }));
    };
  }, [sendMessage]);

  const toggleModifier = useCallback((code: string) => {
    setHeld((prev) => {
      const isHeld = prev.has(code);
      sendMessage({ type: "key", code, down: !isHeld });
      const next = new Set(prev);
      if (isHeld) next.delete(code); else next.add(code);
      return next;
    });
  }, [sendMessage]);

  const tapKey = useCallback((code: string) => {
    sendMessage({ type: "key", code, down: true });
    sendMessage({ type: "key", code, down: false });
  }, [sendMessage]);

  const sendCombo = useCallback((codes: readonly string[]) => {
    // Press down in order, release in reverse — mirrors physically pressing then releasing a
    // chord (last key down first key up would read as a different shortcut on some apps).
    codes.forEach((code) => sendMessage({ type: "key", code, down: true }));
    [...codes].reverse().forEach((code) => sendMessage({ type: "key", code, down: false }));
  }, [sendMessage]);

  return (
    <div
      className="flex shrink-0 gap-1 overflow-x-auto border-t border-white/10 bg-black/90 px-2 py-1.5"
      data-testid="remote-desktop-mobile-key-bar"
    >
      {MODIFIERS.map((m) => (
        <KeyBarButton key={m.code} onClick={() => toggleModifier(m.code)} active={held.has(m.code)}>
          {m.label}
        </KeyBarButton>
      ))}
      <div className="mx-0.5 w-px shrink-0 bg-white/10" />
      {FUNCTION_KEYS.map((k) => (
        <KeyBarButton key={k.code} onClick={() => tapKey(k.code)}>{k.label}</KeyBarButton>
      ))}
      <div className="mx-0.5 w-px shrink-0 bg-white/10" />
      {COMBOS.map((c) => (
        <KeyBarButton key={c.label} onClick={() => sendCombo(c.codes)}>{c.label}</KeyBarButton>
      ))}
    </div>
  );
}
