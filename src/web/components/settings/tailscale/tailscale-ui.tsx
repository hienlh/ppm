/**
 * Parts the Tailscale pane repeats: a copyable command, a link to Tailscale's site styled
 * as a button, and a dialog that is a bottom sheet below `md`.
 */
import { useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink } from "@/lib/icons";
import { buttonVariants } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

/** A command or policy snippet with a copy button. Scrolls sideways rather than wrapping. */
export function CopyableCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!(await copyToClipboard(code))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex items-start rounded-md border border-border bg-muted">
      <pre className="min-w-0 flex-1 overflow-x-auto px-3 py-3 text-xs leading-relaxed"><code>{code}</code></pre>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label="Copy"
        title="Copy"
        className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
      >
        {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}

/** A page on Tailscale's site or admin console, in a new tab that is not told where PPM is reached. */
export function ExternalButton({ href, children, primary = false }: { href: string; children: ReactNode; primary?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(buttonVariants({ variant: primary ? "default" : "outline" }), "min-h-11 md:min-h-9")}
    >
      {children}
      <ExternalLink className="size-3.5" />
    </a>
  );
}

/** Bottom sheet below `md`, centered dialog above. */
export function AdaptiveDialog({ open, title, onClose, children }: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  if (isMobile) {
    return (
      <BottomSheet open={open} onClose={onClose}>
        <div className="px-4 pb-4">
          <h2 className="mb-3 text-base font-semibold">{title}</h2>
          {children}
        </div>
      </BottomSheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
