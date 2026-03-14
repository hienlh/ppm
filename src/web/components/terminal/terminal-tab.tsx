import { useRef, useEffect, useState, useCallback } from "react";
import { useTerminal } from "@/hooks/use-terminal";
import { cn } from "@/lib/utils";
import "@xterm/xterm/css/xterm.css";

interface TerminalTabProps {
  metadata?: Record<string, unknown>;
}

const MOBILE_KEYS = [
  { label: "Tab", value: "\t" },
  { label: "Esc", value: "\x1b" },
  { label: "Ctrl", value: null, isModifier: true },
  { label: "\u2191", value: "\x1b[A" },
  { label: "\u2193", value: "\x1b[B" },
  { label: "\u2190", value: "\x1b[D" },
  { label: "\u2192", value: "\x1b[C" },
] as const;

export function TerminalTab({ metadata }: TerminalTabProps) {
  const sessionId = (metadata?.sessionId as string) ?? "new";
  const projectName = metadata?.projectName as string | undefined;
  const containerRef = useRef<HTMLDivElement>(null);
  const { connected, reconnecting } = useTerminal({ sessionId, projectName, containerRef });
  const [ctrlMode, setCtrlMode] = useState(false);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);

  // Adjust height when mobile keyboard opens
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    function handleResize() {
      if (!vv) return;
      setViewportHeight(vv.height);
    }

    vv.addEventListener("resize", handleResize);
    return () => vv.removeEventListener("resize", handleResize);
  }, []);

  const sendKey = useCallback(
    (value: string) => {
      // Access the terminal container's xterm instance indirectly via the WS
      // The useTerminal hook handles this — we need to dispatch to the terminal
      const termElement = containerRef.current?.querySelector(
        ".xterm-helper-textarea",
      ) as HTMLTextAreaElement | null;

      if (termElement) {
        termElement.focus();
      }

      // For Ctrl combos, we rely on the terminal processing keystrokes
      // For direct chars, dispatch input event
      if (ctrlMode && value.length === 1) {
        // Ctrl+key: send char code 1-26 for a-z
        const code = value.toLowerCase().charCodeAt(0) - 96;
        if (code >= 1 && code <= 26) {
          // The terminal onData handler in useTerminal sends to WS
          const event = new KeyboardEvent("keydown", {
            key: value,
            ctrlKey: true,
            bubbles: true,
          });
          termElement?.dispatchEvent(event);
        }
        setCtrlMode(false);
        return;
      }

      // For simple values, use input event approach by focusing textarea
      // xterm handles the rest
    },
    [ctrlMode],
  );

  const isMobile = typeof window !== "undefined" && "ontouchstart" in window;

  return (
    <div
      className="flex flex-col h-full"
      style={viewportHeight ? { maxHeight: `${viewportHeight}px` } : undefined}
    >
      {/* Status bar */}
      <div className="flex items-center gap-2 px-3 py-1 bg-surface border-b border-border text-xs">
        <span
          className={cn(
            "size-2 rounded-full",
            connected ? "bg-success" : reconnecting ? "bg-warning" : "bg-error",
          )}
        />
        <span className="text-text-secondary">
          {connected
            ? "Connected"
            : reconnecting
              ? "Reconnecting..."
              : "Disconnected"}
        </span>
        <span className="text-text-subtle ml-auto font-mono">{sessionId}</span>
      </div>

      {/* Terminal container */}
      <div ref={containerRef} className="flex-1 min-h-0 bg-background p-1" />

      {/* Mobile toolbar */}
      {isMobile && (
        <div className="flex items-center gap-1 px-2 py-1.5 bg-surface border-t border-border overflow-x-auto">
          {MOBILE_KEYS.map((key) => (
            <button
              key={key.label}
              onClick={() => {
                if (key.label === "Ctrl") {
                  setCtrlMode(!ctrlMode);
                } else if (key.value) {
                  sendKey(key.value);
                }
              }}
              className={cn(
                "px-3 py-1.5 rounded text-xs font-mono min-w-[36px] min-h-[32px]",
                "bg-surface-elevated text-text-primary active:bg-primary active:text-primary-foreground",
                "transition-colors select-none",
                key.label === "Ctrl" && ctrlMode && "bg-primary text-primary-foreground",
              )}
            >
              {key.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
