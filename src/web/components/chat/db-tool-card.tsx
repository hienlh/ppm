/**
 * Card surfaces for PPM's database tools (`db_query`, `open_query`, `db_execute`).
 *
 * Rendered by `tool-cards.tsx`; the call is read by `@/lib/db-tool-call`. The header names the
 * connection and, for a change, the AI's reason: that is what the user approved. The SQL itself
 * is in the expanded body, in full.
 */
import { DB_EXECUTE_TOOL } from "../../../shared/db-ai-tools";
import { DB_TOOL_LABELS, type DbToolCall } from "@/lib/db-tool-call";

const firstLine = (text: string) => text.split("\n").find((l) => l.trim())?.trim() ?? "";
const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** One-line header: what the tool does, on which connection, and its reason or first SQL line. */
export function DbToolSummary({ call }: { call: DbToolCall }) {
  const detail = call.tool === DB_EXECUTE_TOOL && call.reason ? call.reason : firstLine(call.sql);
  return (
    <>
      {DB_TOOL_LABELS[call.tool]}{" "}
      <span className="text-text-primary">{call.connection}{call.database ? ` / ${call.database}` : ""}</span>
      {detail && <span className={`text-text-subtle${detail === call.reason ? "" : " font-mono"}`}> · {cap(detail, 60)}</span>}
    </>
  );
}

/** Expanded body: connection, the reason the user read, the SQL, and the row count it expects. */
export function DbToolDetails({ call }: { call: DbToolCall }) {
  return (
    <div className="space-y-1">
      <p className="flex flex-wrap items-center gap-1.5">
        <span className="text-text-subtle">Connection</span>
        <span className="font-medium text-text-primary">{call.connection}</span>
        {call.database && <span className="text-text-subtle">database <span className="font-mono text-text-secondary">{call.database}</span></span>}
      </p>
      {call.reason && <p className="text-text-secondary italic">{call.reason}</p>}
      <pre className="font-mono text-text-secondary overflow-auto max-h-60 whitespace-pre-wrap break-all">{call.sql}</pre>
      {call.expectedRows != null && (
        <p className="text-text-subtle">Expected rows changed: <span className="text-text-secondary">{call.expectedRows}</span></p>
      )}
    </div>
  );
}
