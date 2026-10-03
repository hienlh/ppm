/**
 * A JSON value as DBGate's Cell data view draws it: objects and lists fold, with the outermost one
 * open — or every one, for Json - expanded. A folded one says how many keys or items it holds, and a
 * list too long to draw at once shows its first items with a way to draw more.
 */
import { useState, type ReactNode } from "react";
import { ChevronRight } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { formatBinary, isBinaryValue } from "./cell-display";

/** Children of one object or list drawn at a time. */
const PAGE = 200;

export function JsonTree({ value, expandAll = false, className }: { value: unknown; expandAll?: boolean; className?: string }) {
  return (
    <div role="tree" aria-label="JSON value" className={cn("font-mono text-xs leading-[1.55]", className)}>
      <JsonNode value={value} depth={0} expandAll={expandAll} />
    </div>
  );
}

function JsonNode({ name, value, depth, expandAll }: { name?: ReactNode; value: unknown; depth: number; expandAll: boolean }) {
  const branch = value !== null && typeof value === "object" && !isBinaryValue(value);
  const [open, setOpen] = useState(expandAll || depth === 0);
  const [shown, setShown] = useState(PAGE);
  const label = name !== undefined && <><span className="text-info">{name}</span><span className="text-text-3">: </span></>;
  if (!branch) {
    return <div role="treeitem" className="pl-3 break-all whitespace-pre-wrap">{label}<JsonLeaf value={value} /></div>;
  }
  const list = Array.isArray(value);
  const entries: [string, unknown][] = list ? value.map((v, i) => [String(i), v]) : Object.entries(value as Record<string, unknown>);
  const [openMark, closeMark] = list ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) {
    return <div role="treeitem" className="pl-3">{label}<span className="text-text-3">{openMark}{closeMark}</span></div>;
  }
  const count = `${entries.length.toLocaleString()} ${list ? (entries.length === 1 ? "item" : "items") : entries.length === 1 ? "key" : "keys"}`;
  return (
    <div role="treeitem" aria-expanded={open}>
      <button
        type="button" onClick={() => setOpen(!open)} aria-label={`${open ? "Fold" : "Unfold"} ${typeof name === "string" ? name : "the value"}`}
        className="flex w-full items-start text-left can-hover:hover:bg-surface-hover"
      >
        <ChevronRight className={cn("mt-[3px] size-3 shrink-0 text-text-3 transition-transform", open && "rotate-90")} aria-hidden />
        <span className="min-w-0 break-all">
          {label}
          <span className="text-text-3">{openMark}</span>
          {!open && <span className="text-text-3">…{closeMark} {count}</span>}
        </span>
      </button>
      {open && (
        <>
          <div role="group" className="pl-4">
            {entries.slice(0, shown).map(([key, child]) => (
              <JsonNode key={key} name={list ? <span className="text-text-3">{key}</span> : key} value={child} depth={depth + 1} expandAll={expandAll} />
            ))}
            {entries.length > shown && (
              <button type="button" onClick={() => setShown(shown + PAGE)} className="pl-3 text-primary can-hover:hover:underline">
                Show {Math.min(PAGE, entries.length - shown).toLocaleString()} more of {(entries.length - shown).toLocaleString()}
              </button>
            )}
          </div>
          <div className="pl-3 text-text-3">{closeMark}</div>
        </>
      )}
    </div>
  );
}

function JsonLeaf({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-text-3 italic">null</span>;
  if (isBinaryValue(value)) return <span className="text-text-3">{formatBinary(value)}</span>;
  if (typeof value === "string") return <span className="text-success">{JSON.stringify(value)}</span>;
  return <span className="text-warning">{String(value)}</span>;
}
