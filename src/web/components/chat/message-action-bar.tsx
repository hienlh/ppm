import { useState, type ReactNode } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatRelativeDate } from "@/lib/format-date";

/** Full timestamp for the relative-time tooltip. */
function fullDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "";
  }
}

/**
 * Ghost-pill action button (icon + label) for the message action bar.
 * 44px min touch target on mobile; tighter on desktop. Always visible.
 */
export function ActionButton({
  icon,
  label,
  title,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={label}
      className="inline-flex items-center justify-center gap-1 rounded-md px-1.5 py-1 text-text-subtle hover:text-text-primary hover:bg-surface transition-colors"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/** Copy-to-clipboard button — swaps to check + "Copied" for 1.5s. */
function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <ActionButton
      icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      label={copied ? "Copied" : "Copy"}
      title="Copy message to clipboard"
      onClick={() => {
        navigator.clipboard?.writeText(content).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    />
  );
}

/**
 * Always-visible action row rendered below a chat message (user or assistant).
 * Presentational only — caller supplies extra actions (edit/fork, later save/star)
 * via `children`. Renders relative time (full date on hover) + copy.
 */
export function MessageActionBar({
  timestamp,
  content,
  accountLabel,
  className,
  children,
}: {
  timestamp: string;
  content: string;
  accountLabel?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-0.5 flex-wrap text-xs text-text-subtle select-none",
        className,
      )}
    >
      <time title={fullDate(timestamp)} className="pr-1 tabular-nums">
        {formatRelativeDate(timestamp)}
      </time>
      {accountLabel && <span className="px-1 truncate max-w-40">via {accountLabel}</span>}
      <CopyButton content={content} />
      {children}
    </div>
  );
}
