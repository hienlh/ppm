/**
 * One CHANGELOG version section: version heading, category headings, bullets.
 *
 * Two sizes because it is read in two places. The status-bar popover is 18rem wide and shows
 * a glance (`compact`); the release-notes window is where the notes are actually read
 * (`comfortable`), so it gets body-size text and keeps the entries' bold lead-ins and code.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** `**bold**` and `` `code` `` as elements; everything else stays text. No HTML is parsed. */
function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(m[1] !== undefined
      // A lead-in often holds a command (`**Run `ppm x` first.**`), so its inside is rendered too.
      ? <strong key={m.index} className="font-semibold text-text">{renderInline(m[1])}</strong>
      : <code key={m.index} className="rounded bg-surface-elevated px-1 py-px font-mono text-[0.9em] text-text">{m[2]}</code>);
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function ReleaseNotesEntry({ version, date, body, size = "compact", installed = false }: {
  version: string;
  date?: string;
  body: string;
  size?: "compact" | "comfortable";
  /** This is the version running now. */
  installed?: boolean;
}) {
  const comfy = size === "comfortable";
  return (
    <section>
      <div className={cn("flex items-baseline gap-2", comfy ? "mb-2" : "mb-1")}>
        <span className={cn("font-mono font-semibold text-text", comfy ? "text-base" : "text-[11px]")}>v{version}</span>
        {comfy && date && <span className="text-xs text-text-3">{date}</span>}
        {installed && (
          <span className={cn("rounded-full bg-primary/15 font-medium text-primary", comfy ? "px-2 py-0.5 text-[11px]" : "px-1.5 text-[10px]")}>
            installed
          </span>
        )}
      </div>
      <div className={comfy ? "space-y-2" : "space-y-1"}>
        {body.split("\n").map((line, i) => {
          const t = line.trim();
          if (!t) return null;
          if (t.startsWith("### ")) {
            return (
              <div key={i} className={cn("font-semibold uppercase tracking-wide text-text-3", comfy ? "pt-2 text-[11px]" : "pt-1 text-[10px]")}>
                {t.slice(4)}
              </div>
            );
          }
          if (t.startsWith("- ")) {
            return (
              <div key={i} className="flex gap-2 text-text-2">
                <span className="shrink-0 text-text-3">•</span>
                <span className="min-w-0 break-words">{renderInline(t.slice(2))}</span>
              </div>
            );
          }
          return <div key={i} className="break-words text-text-2">{renderInline(t)}</div>;
        })}
      </div>
    </section>
  );
}
