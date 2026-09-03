import { useRef, useEffect, useState, useCallback, memo } from "react";
import { useTerminal } from "@/hooks/use-terminal";
import { useTerminalTouchSelection } from "@/hooks/use-terminal-touch-selection";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { RotateCcw, MessageSquare } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { toast } from "sonner";

import { usePanelStore } from "@/stores/panel-store";
import { TerminalMobileToolbar } from "./terminal-mobile-toolbar";
import { TerminalLinksSheet } from "./terminal-links-sheet";

interface TerminalTabProps {
  metadata?: Record<string, unknown>;
  tabId?: string;
}

export const TerminalTab = memo(function TerminalTab({ metadata, tabId }: TerminalTabProps) {
  const sessionId = (metadata?.sessionId as string) ?? "new";
  const projectName = metadata?.projectName as string | undefined;
  const cwd = metadata?.cwd as string | undefined;
  const containerRef = useRef<HTMLDivElement>(null);

  const { connected, reconnecting, exited, sendData, getSelection, getLastCommandOutput, getBufferUrls, restart } = useTerminal({ sessionId, projectName, cwd, containerRef, tabId });
  const [ctrlMode, setCtrlMode] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);

  useTerminalTouchSelection(containerRef, selectMode);

  const focusTerminal = useCallback(() => {
    const termElement = containerRef.current?.querySelector(
      ".xterm-helper-textarea",
    ) as HTMLTextAreaElement | null;
    termElement?.focus();
  }, []);

  // Raising the soft keyboard needs focus() to run inside a gesture the browser
  // recognises, and xterm's own mousedown handling does not reliably qualify.
  // Capture-phase `touchend` runs before xterm's handlers and is unambiguously a
  // gesture, so the keyboard opens even when the click path is unreliable.
  // Skipped in select mode: a drag there is a selection gesture, and raising the
  // keyboard would both shrink the viewport mid-drag and clear the selection.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || selectMode) return;
    const onTouchEnd = () => focusTerminal();
    container.addEventListener("touchend", onTouchEnd, { capture: true });
    return () => container.removeEventListener("touchend", onTouchEnd, { capture: true });
  }, [focusTerminal, selectMode]);

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

  // xterm starts a selection from mousedown and has no touch equivalent, so on a
  // phone getSelection() is always empty. Falling back to the last command's
  // output keeps the button useful instead of silently doing nothing.
  const handleCopy = useCallback(async () => {
    const selection = getSelection();
    const text = selection || getLastCommandOutput();
    if (!text.trim()) {
      toast("Nothing to copy", { duration: 1500 });
      return;
    }
    const ok = await copyToClipboard(text);
    toast[ok ? "success" : "error"](
      ok ? (selection ? "Selection copied" : "Last output copied") : "Could not copy",
      { duration: 1500 },
    );
  }, [getSelection, getLastCommandOutput]);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        sendData(text);
        focusTerminal();
      }
    } catch {
      // readText() needs a secure context and an explicit permission grant, and
      // Safari rejects it outright when the tap is not treated as a gesture.
      // Say so — a silent catch reads as a dead button.
      toast.error("Clipboard blocked — paste with the keyboard instead", { duration: 2500 });
    }
  }, [sendData, focusTerminal]);

  const handleSendToChat = useCallback(() => {
    const selection = getSelection();
    const text = selection || getLastCommandOutput();
    if (!text.trim()) return;
    const codeBlock = "```bash\n" + text + "\n```";
    const label = selection ? "Terminal selection" : "Terminal output";

    // Try to inject into an already-open chat tab as attachment chip
    let handled = false;
    const handler = () => { handled = true; };
    window.addEventListener("ppm:send-to-chat:ack", handler, { once: true });
    window.dispatchEvent(new CustomEvent("ppm:send-to-chat", { detail: { text: codeBlock, label, projectName } }));
    window.removeEventListener("ppm:send-to-chat:ack", handler);

    if (handled) {
      toast.success("Sent to chat", { duration: 1500 });
    } else {
      // No chat tab mounted — open a new one with the content as initialValue
      usePanelStore.getState().openTab({
        type: "chat",
        title: "Chat",
        projectId: null,
        metadata: { projectName, pendingMessage: codeBlock },
        closable: true,
      });
    }
  }, [getSelection, getLastCommandOutput, projectName]);

  const isMobile = typeof window !== "undefined" && "ontouchstart" in window;

  return (
    <div className="flex flex-col h-full min-h-0">
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
        <button
          onClick={handleSendToChat}
          title="Send to Chat"
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-surface-elevated text-text-primary hover:bg-primary hover:text-primary-foreground active:bg-primary active:text-primary-foreground transition-colors ml-auto"
        >
          <MessageSquare size={10} />
          Chat
        </button>
        <span className="text-text-subtle font-mono">{sessionId}</span>
      </div>

      {/* Terminal container. onClick focuses xterm's hidden textarea — on mobile
          the soft keyboard only opens when focus() runs inside a recognized tap
          gesture, which xterm's internal mousedown handling doesn't reliably do. */}
      <div
        ref={containerRef}
        onClick={selectMode ? undefined : focusTerminal}
        className={cn("flex-1 min-h-0 bg-background p-1", selectMode && "touch-none")}
      />

      {isMobile && (
        <>
          <TerminalMobileToolbar
            ctrlMode={ctrlMode}
            onToggleCtrl={() => setCtrlMode(!ctrlMode)}
            selectMode={selectMode}
            onToggleSelect={() => setSelectMode(!selectMode)}
            onKey={sendKey}
            onCopy={() => void handleCopy()}
            onPaste={() => void handlePaste()}
            onSendToChat={handleSendToChat}
            onOpenLinks={() => setLinksOpen(true)}
          />
          <TerminalLinksSheet
            open={linksOpen}
            onClose={() => setLinksOpen(false)}
            urls={linksOpen ? getBufferUrls() : []}
          />
        </>
      )}
    </div>
  );
});
