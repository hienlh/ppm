/**
 * The one piece of clipboard UI, shared by the desktop window and the mobile viewer.
 *
 * It exists because both failure modes of clipboard sync are otherwise *silent*: text the host
 * copied cannot be written to this device without a secure context (PPM is usually plain HTTP on
 * a LAN), and a host with no `xclip`/`wl-copy` installed simply does nothing. One is fixed by a
 * click, the other by a command — so this renders whichever applies and nothing at all when
 * sync is working.
 */
import { useState } from "react";
import { Clipboard, ClipboardCheck, TerminalSquare, X } from "@/lib/icons";
import { runInTerminal } from "@/lib/run-in-terminal";
import { cn } from "@/lib/utils";
import { copyTextWithGesture } from "./remote-desktop-clipboard-client";
import type { RequirementAction } from "./use-remote-desktop-readiness";

export interface RemoteDesktopClipboardNoticeProps {
  /** Host text that needs a real click to reach this device's clipboard. */
  pendingText: string | null;
  onDismiss: () => void;
  /** Set when the user tried to paste and the *host* has no clipboard tool. */
  missingToolAction?: RequirementAction | null;
  onDismissMissingTool?: () => void;
  /** Override the bar's placement. The desktop window floats it over the video; the mobile
   *  viewer puts it in normal flow above the toolbar, which the on-screen keyboard already
   *  lifts — floating it there would land it behind the toolbar instead. */
  positionClassName?: string;
}

export function RemoteDesktopClipboardNotice({
  pendingText,
  onDismiss,
  missingToolAction,
  onDismissMissingTool,
  positionClassName = "absolute bottom-2 left-1/2 max-w-[92%] -translate-x-1/2",
}: RemoteDesktopClipboardNoticeProps) {
  const [copyFailed, setCopyFailed] = useState(false);

  if (pendingText !== null) {
    const onCopy = () => {
      // Synchronous inside the click: `execCommand` is ignored outside a user gesture.
      if (copyTextWithGesture(pendingText)) onDismiss();
      else setCopyFailed(true);
    };
    return (
      <NoticeBar onDismiss={onDismiss} testId="remote-desktop-clipboard-pending" positionClassName={positionClassName}>
        <ClipboardCheck className="size-4 shrink-0 text-emerald-400" />
        <span className="min-w-0 flex-1 truncate">
          {copyFailed ? "Could not copy — select the text manually:" : "Copied on the host:"}
          <span className="ml-1 text-white/60">{preview(pendingText)}</span>
        </span>
        <button
          type="button"
          onClick={onCopy}
          className="min-h-8 shrink-0 rounded bg-white/15 px-2.5 text-xs hover:bg-white/25"
          data-testid="remote-desktop-clipboard-copy"
        >
          Copy here
        </button>
      </NoticeBar>
    );
  }

  if (missingToolAction !== undefined && missingToolAction !== null) {
    return (
      <NoticeBar
        onDismiss={onDismissMissingTool ?? (() => {})}
        testId="remote-desktop-clipboard-missing-tool"
        positionClassName={positionClassName}
      >
        <Clipboard className="size-4 shrink-0 text-amber-300" />
        <span className="min-w-0 flex-1">The host has no clipboard tool installed.</span>
        {missingToolAction.kind === "terminal" && (
          <button
            type="button"
            onClick={() => runInTerminal(missingToolAction.command)}
            title={missingToolAction.command}
            className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded bg-white/15 px-2.5 text-xs hover:bg-white/25"
          >
            <TerminalSquare className="size-3.5" /> {missingToolAction.label}
          </button>
        )}
      </NoticeBar>
    );
  }

  return null;
}

/** Bottom-centre by default, so it never covers the corner controls. */
function NoticeBar({
  children,
  onDismiss,
  testId,
  positionClassName,
}: {
  children: React.ReactNode;
  onDismiss: () => void;
  testId: string;
  positionClassName: string;
}) {
  return (
    <div
      className={cn(
        "z-50 flex items-center gap-2 rounded-lg border border-white/10 bg-black/85 px-3 py-2 text-xs text-white shadow-lg",
        positionClassName,
      )}
      data-testid={testId}
    >
      {children}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="flex size-8 shrink-0 items-center justify-center rounded text-white/60 hover:bg-white/10 hover:text-white"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** Enough to recognise the text, on one line — a pasted stack trace must not take the screen. */
function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}
