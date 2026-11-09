import { useEffect, type ReactNode } from "react";
import { Link2Off, Loader2, RefreshCw, X } from "@/lib/icons";
import { buttonOutline, buttonPrimary, buttonQuiet, cx } from "./share-ui";

/** The page's whole-screen states, and the one-line notice a failed write or a wait shows. */

function Centered({ children }: { children: ReactNode }) {
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-3 bg-bg p-6 text-center text-text">{children}</main>
  );
}

export function ShareLoading() {
  return (
    <Centered>
      <Loader2 className="size-6 animate-spin text-text-3" />
      <p className="text-sm text-text-2">Opening the design…</p>
    </Centered>
  );
}

/** Same words for every reason a link stops opening, as the server gives no reason either. */
export function ShareInvalid() {
  return (
    <Centered>
      <Link2Off className="size-8 text-text-3" />
      <h1 className="text-lg font-semibold">This link is no longer valid</h1>
      <p className="max-w-sm text-sm text-text-2">Ask the person who shared it for a new link.</p>
    </Centered>
  );
}

export function ShareFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Centered>
      <p className="max-w-sm text-sm text-text-2">{message}</p>
      <button type="button" className={buttonOutline} onClick={onRetry}><RefreshCw className="size-4" /> Try again</button>
    </Centered>
  );
}

/**
 * Shown once the owner has re-pinned the link: the page still shows the version it loaded,
 * which nobody can comment on any more. Stays until the reviewer reloads; nothing else
 * brings the design, its title and its date up to date together.
 */
export function ShareUpdatedBar({ onReload }: { onReload: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-y border-border bg-panel-2 py-1 pl-4 pr-2 text-sm" role="status" aria-live="polite">
      <RefreshCw className="size-4 shrink-0 text-text-3" />
      <span className="min-w-0 flex-1">This design was updated.</span>
      <button type="button" className={buttonPrimary} onClick={onReload}>Reload</button>
    </div>
  );
}

const NOTICE_MS = 6000;

/**
 * A transient notice, drawn above everything including an open sheet (a refused write is
 * usually made from one). At the top on a phone, where a sheet's form and keyboard cannot
 * cover it; at the bottom on a desktop.
 */
export function ShareNotice({ message, onDismiss, top }: { message: string; onDismiss: () => void; top: boolean }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, NOTICE_MS);
    return () => clearTimeout(timer);
  }, [onDismiss]);
  return (
    <div className={cx("pointer-events-none fixed inset-x-0 z-[60] flex justify-center px-3",
      top ? "top-[max(0.5rem,env(safe-area-inset-top))]" : "bottom-4")}>
      <div className="pointer-events-auto flex max-w-md items-center gap-2 rounded-lg border border-border bg-panel py-1 pl-3 pr-1 text-sm shadow-lg" role="status" aria-live="polite">
        <span className="min-w-0 flex-1">{message}</span>
        <button type="button" className={buttonQuiet} onClick={onDismiss} aria-label="Dismiss"><X className="size-4" /></button>
      </div>
    </div>
  );
}
