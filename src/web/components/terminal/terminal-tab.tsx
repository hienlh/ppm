import { useRef, useEffect, useState, useCallback, memo } from "react";
import { useTerminal } from "@/hooks/use-terminal";
import { cn } from "@/lib/utils";
import { Copy, ClipboardPaste, RotateCcw } from "lucide-react";
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

export const TerminalTab = memo(function TerminalTab({ metadata }: TerminalTabProps) {
  const sessionId = (metadata?.sessionId as string) ?? "new";
  const projectName = metadata?.projectName as string | undefined;
  const containerRef = useRef<HTMLDivElement>(null);
  const { connected, reconnecting, exited, sendData, getSelection, restart } = useTerminal({ sessionId, projectName, containerRef });
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

  const focusTerminal = useCallback(() => {
    const termElement = containerRef.current?.querySelector(
      ".xterm-helper-textarea",
    ) as HTMLTextAreaElement | null;
    termElement?.focus();
  }, []);

  const sendKey = useCallback(
    (value: string) => {
      focusTerminal();

      if (ctrlMode && value.length === 1) {
        // Ctrl+key: send char code 1-26 for a-z
        const code = value.toLowerCase().charCodeAt(0) - 96;
        if (code >= 1 && code <= 26) {
          sendData(String.fromCharCode(code));
        }
        setCtrlMode(false);
        return;
      }

      sendData(value);
    },
    [ctrlMode, sendData, focusTerminal],
  );

  const handleCopy = useCallback(async () => {
    const selection = getSelection();
    if (selection) {
      await navigator.clipboard.writeText(selection);
    }
  }, [getSelection]);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        sendData(text);
        focusTerminal();
      }
    } catch {
      // Clipboard permission denied
    }
  }, [sendData, focusTerminal]);

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
            exited ? "bg-error" : connected ? "bg-success" : reconnecting ? "bg-warning" : "bg-error",
          )}
        />
        <span className="text-text-secondary">
          {exited
            ? "Process exited"
            : connected
              ? "Connected"
              : reconnecting
                ? "Reconnecting..."
                : "Disconnected"}
        </span>
        {exited && (
          <button
            onClick={restart}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-surface-elevated text-text-primary hover:bg-primary hover:text-primary-foreground active:bg-primary active:text-primary-foreground transition-colors"
          >
            <RotateCcw size={10} />
            Restart
          </button>
        )}
        <span className="text-text-subtle ml-auto font-mono">{sessionId}</span>
      </div>

      {/* Terminal container */}
      <div ref={containerRef} className="flex-1 min-h-0 bg-background p-1" />

      {/* Mobile toolbar */}
      {isMobile && (
        <div className="flex items-center gap-1 px-2 py-1.5 bg-surface border-t border-border overflow-x-auto">
          <button
            onClick={handleCopy}
            className="px-2 py-1.5 rounded text-xs min-w-[36px] min-h-[32px] bg-surface-elevated text-text-primary active:bg-primary active:text-primary-foreground transition-colors select-none"
          >
            <Copy size={14} />
          </button>
          <button
            onClick={handlePaste}
            className="px-2 py-1.5 rounded text-xs min-w-[36px] min-h-[32px] bg-surface-elevated text-text-primary active:bg-primary active:text-primary-foreground transition-colors select-none"
          >
            <ClipboardPaste size={14} />
          </button>
          <div className="w-px h-5 bg-border mx-0.5" />
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
});
