/**
 * Tappable list of URLs found in the terminal scrollback.
 *
 * xterm resolves a link from a mouse hover and opens it on mouseup, so a touch
 * device can never activate one — and without touch selection the URL cannot be
 * copied out either. This sheet is the touch path to both.
 *
 * It also carries the way out of a login started here but finished on another
 * device: see TerminalFinishLogin.
 */
import { ExternalLink, Copy, Link2Off } from "lucide-react";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { copyToClipboard } from "@/lib/clipboard";
import { loopbackRedirectPort } from "@/lib/oauth-loopback-url";
import { TerminalFinishLogin } from "./terminal-finish-login";
import { toast } from "sonner";

interface TerminalLinksSheetProps {
  open: boolean;
  onClose: () => void;
  urls: string[];
}

export function TerminalLinksSheet({ open, onClose, urls }: TerminalLinksSheetProps) {
  const handleCopy = async (url: string) => {
    const ok = await copyToClipboard(url);
    toast[ok ? "success" : "error"](ok ? "Link copied" : "Could not copy link", { duration: 1500 });
    onClose();
  };

  // Ports any listed login will redirect back to. Their presence is what makes
  // the finish-login step relevant, so it stays hidden the rest of the time.
  const loopbackPorts = [...new Set(urls.map(loopbackRedirectPort).filter((p): p is string => !!p))];

  return (
    // Above the mobile dock sheet (z-60) this is opened from, or it renders
    // behind the dock and cannot be reached at all.
    <BottomSheet open={open} onClose={onClose} zIndex={70} className="flex flex-col max-h-[70vh]">
      <div className="shrink-0 px-4 pb-2 text-xs font-medium text-text-secondary">
        {urls.length > 0 ? `Links in terminal (${urls.length})` : "Links in terminal"}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {urls.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-text-secondary">
            <Link2Off className="size-5 text-text-subtle" />
            No links found in the visible scrollback.
          </div>
        ) : (
          urls.map((url) => {
            const port = loopbackRedirectPort(url);
            return (
              <div key={url}>
                <div className="flex items-stretch gap-1">
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer noopener"
                    onClick={onClose}
                    className="flex min-h-11 flex-1 min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-sm text-foreground active:bg-accent transition-colors"
                  >
                    <ExternalLink className="size-4 shrink-0 text-text-subtle" />
                    <span className="min-w-0 flex-1 truncate text-left font-mono text-xs">{url}</span>
                  </a>
                  <button
                    onClick={() => void handleCopy(url)}
                    aria-label={`Copy ${url}`}
                    className="flex size-11 shrink-0 items-center justify-center rounded-lg text-text-secondary active:bg-accent transition-colors"
                  >
                    <Copy className="size-4" />
                  </button>
                </div>
                {port && (
                  <p className="px-3 pb-2 text-[11px] leading-snug text-text-secondary">
                    Signing in here sends you back to port {port} <strong>on the machine</strong>,
                    not this device — so the terminal keeps waiting. Afterwards, paste the address
                    bar below to finish it.
                  </p>
                )}
              </div>
            );
          })
        )}
      </div>

      {loopbackPorts.length > 0 && <TerminalFinishLogin onDone={onClose} />}
    </BottomSheet>
  );
}
