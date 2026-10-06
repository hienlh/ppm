/**
 * Small pieces every Logs pane draws the same way: a source's icon, a record's message with its
 * chat chips and search hits, the compact one-line form used by an issue's evidence and a
 * report's snippets, and the Live / Paused indicator.
 */
import { Fragment, type ElementType, type ReactNode } from "react";
import {
  Activity, Bot, CalendarClock, Cloud, Folder, Globe, Layers, Pause, Puzzle, Terminal, Wifi,
} from "@/lib/icons";
import { clockTime, messagePieces, splitHits, type LogRow } from "@/lib/logs/logs-view-model";
import type { LogLevel, LogSourceId } from "../../../shared/logs-model";

export const SOURCE_ICONS: Readonly<Record<LogSourceId | "all", ElementType>> = {
  all: Layers,
  ai: Bot,
  shell: Terminal,
  server: Activity,
  ext: Puzzle,
  files: Folder,
  auto: CalendarClock,
  tunnel: Cloud,
  browser: Globe,
};

export const LEVEL_TEXT: Readonly<Record<LogLevel, string>> = {
  debug: "DEBUG", info: "INFO", warn: "WARN", error: "ERROR", fatal: "FATAL",
};

/** `text` with every search hit marked. */
export function Hits({ text, re }: { text: string; re: RegExp | null }) {
  if (!re) return <>{text}</>;
  return (
    <>
      {splitHits(text, re).map((p, i) => (p.hit ? <mark key={i} className="lg-hit">{p.text}</mark> : <Fragment key={i}>{p.text}</Fragment>))}
    </>
  );
}

/**
 * A message as a row shows it: `session=<id>` becomes the chat's name, which filters to that
 * chat when clicked; `key=` and quoted values are toned down.
 */
export function MessageText({ msg, re, titles, onChat }: {
  msg: string;
  re: RegExp | null;
  titles: Readonly<Record<string, string>>;
  onChat?: (sid: string) => void;
}) {
  return (
    <>
      {messagePieces(msg).map((p, i) => {
        if (p.kind === "chat") {
          const name = titles[p.sid] ?? p.sid.slice(0, 8);
          return onChat ? (
            <button key={i} type="button" className="lg-sess" title={`Show only this chat · ${p.sid}`} onClick={() => onChat(p.sid)}>
              {name}
            </button>
          ) : <span key={i} className="lg-sess">{name}</span>;
        }
        if (p.kind === "quote") return <span key={i} className="q"><Hits text={p.text} re={re} /></span>;
        if (p.kind === "key") return <span key={i} className="k"><Hits text={p.text} re={re} /></span>;
        return <Hits key={i} text={p.text} re={re} />;
      })}
    </>
  );
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** One record on one line, chat ids cut to eight characters: an issue's evidence, a snippet's lines. */
export function CompactLine({ row, utc, ctx, trim }: { row: LogRow; utc: boolean; ctx?: boolean; trim?: boolean }) {
  const e = row.entry;
  const msg = e.msg.replace(UUID, (u) => u.slice(0, 8));
  const text = trim && msg.length > 150 ? `${msg.slice(0, 149)}…` : msg;
  return (
    <div className={ctx ? "r ctx" : "r"}>
      <span className="t">{clockTime(e.ts, utc)}</span>{"  "}
      <span className={e.lv}>{LEVEL_TEXT[e.lv].padEnd(5, " ")}</span>{" "}
      <span className="g">{e.tag}</span>{"  "}
      {text}
      {row.count > 1 && <span className="t">{` ×${row.count}`}</span>}
      {!!e.more?.length && <span className="t">{` +${e.more.length} lines`}</span>}
    </div>
  );
}

export function LiveIndicator({ paused, pending }: { paused: boolean; pending: number }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-[10px] text-text-subtle" data-testid="logs-live">
      {paused ? <Pause className="size-3 text-warning" /> : <Wifi className="size-3 text-success" />}
      <span>{paused ? `Paused${pending ? ` · ${pending.toLocaleString("en-US")} new` : ""}` : "Live"}</span>
    </span>
  );
}

/** A labelled group of chips, as the phone's filter sheet lays them out. */
export function SheetSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <div className="lg-sheet-sec">{title}</div>
      <div className="lg-sheet-chips">{children}</div>
    </>
  );
}
