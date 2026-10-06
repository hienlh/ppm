/**
 * DBGate's Messages tab: what the run said, one row each — Number, Message, Time, Delta (since the
 * run began), Duration (since the row before) and the editor Line it is about, which a click takes
 * the cursor to. The same columns as the Import/Export tab's Messages. A phone keeps the message
 * and the line.
 *
 * A script of thousands of statements says thousands of things, so a row is rendered again only
 * when it is new. Not `content-visibility`, which the web tree does not use (message-ordinals.test.tsx).
 */
import { memo } from "react";
import { AlertCircle, CheckCircle2, Info, TriangleAlert } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { formatDuration, messageClock } from "../impexp/impexp-state";
import type { QueryMessage } from "./query-run-state";

const COLUMNS = "grid grid-cols-[3rem_minmax(0,1fr)_4.5rem_4rem_4.5rem_3.5rem] max-md:grid-cols-[minmax(0,1fr)_4rem]";
const DESKTOP_ONLY = "max-md:hidden";

const ICONS = {
  info: { Icon: Info, className: "text-text-subtle" },
  success: { Icon: CheckCircle2, className: "text-success" },
  warning: { Icon: TriangleAlert, className: "text-warning" },
  error: { Icon: AlertCircle, className: "text-destructive" },
} as const;

export function MessagesPanel({ messages, onShowLine }: {
  messages: readonly QueryMessage[];
  /** The editor's cursor to `line`; absent where there is no editor to show it in. */
  onShowLine?: (line: number) => void;
}) {
  const first = messages[0]?.time ?? 0;
  return (
    <div className="min-h-0 flex-1 overflow-auto text-xs" role="table" aria-label="Messages">
      <div role="row" className={cn(COLUMNS, "sticky top-0 z-[1] h-6 items-center border-b border-border bg-panel-2 px-1 text-[11px] font-medium text-text-2")}>
        <span role="columnheader" className={cn("px-1 text-right", DESKTOP_ONLY)}>Number</span>
        <span role="columnheader" className="px-1">Message</span>
        <span role="columnheader" className={cn("px-1", DESKTOP_ONLY)}>Time</span>
        <span role="columnheader" className={cn("px-1 text-right", DESKTOP_ONLY)}>Delta</span>
        <span role="columnheader" className={cn("px-1 text-right", DESKTOP_ONLY)}>Duration</span>
        <span role="columnheader" className="px-1 text-right">Line</span>
      </div>
      {messages.map((m, i) => (
        <MessageRow key={m.id} message={m} first={first} previous={i === 0 ? null : messages[i - 1]!.time} onShowLine={onShowLine} />
      ))}
    </div>
  );
}

const MessageRow = memo(function MessageRow({ message: m, first, previous, onShowLine }: {
  message: QueryMessage;
  first: number;
  previous: number | null;
  onShowLine?: (line: number) => void;
}) {
  const { Icon, className } = ICONS[m.level];
  const goes = m.line !== undefined && onShowLine ? () => onShowLine(m.line!) : undefined;
  return (
    <div
      role="row"
      className={cn(
        COLUMNS, "items-start border-b border-border-soft px-1 py-1",
        "max-md:min-h-11 max-md:items-center max-md:text-sm",
        goes && "cursor-pointer can-hover:hover:bg-surface-hover",
      )}
      onClick={goes}
    >
      <span role="cell" className={cn("px-1 text-right text-text-subtle tabular-nums", DESKTOP_ONLY)}>{m.id + 1}</span>
      <span
        role="cell"
        className={cn(
          "flex min-w-0 gap-1.5 px-1 break-words whitespace-pre-wrap",
          m.level === "error" ? "text-destructive" : m.level === "warning" ? "text-warning" : "text-text-primary",
        )}
      >
        <Icon aria-hidden className={cn("mt-px size-3.5 shrink-0 max-md:mt-0.5", className)} />
        <span className="min-w-0">{m.text}</span>
      </span>
      <span role="cell" className={cn("px-1 whitespace-nowrap text-text-2 tabular-nums", DESKTOP_ONLY)}>{messageClock(m.time)}</span>
      <span role="cell" className={cn("px-1 text-right whitespace-nowrap text-text-2 tabular-nums", DESKTOP_ONLY)}>{formatDuration(m.time - first)}</span>
      <span role="cell" className={cn("px-1 text-right whitespace-nowrap text-text-2 tabular-nums", DESKTOP_ONLY)}>
        {previous === null ? "n/a" : formatDuration(m.time - previous)}
      </span>
      <span role="cell" className="px-1 text-right tabular-nums">
        {m.line !== undefined && (goes
          ? (
            <button
              type="button" onClick={(e) => { e.stopPropagation(); goes(); }}
              title={`Show line ${m.line} in the editor`}
              className="text-primary underline-offset-2 can-hover:hover:underline max-md:min-h-11 max-md:px-2"
            >
              {m.line}
            </button>
          )
          : <span className="text-text-2">{m.line}</span>)}
      </span>
    </div>
  );
});
