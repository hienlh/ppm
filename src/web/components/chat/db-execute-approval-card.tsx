import { useState } from "react";
import { ShieldAlert } from "@/lib/icons";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { DB_TYPE_LABELS } from "../../../shared/db-types";
import type { DbApprovalAnswer, DbExecuteApprovalInput } from "../../../shared/db-ai-tools";

/**
 * The prompt for a change the AI asked to make with `db_execute`: the connection, the AI's reason
 * and the exact SQL, run once if the user types PPM's password.
 *
 * The answer goes over HTTP rather than the chat socket, so a wrong password is answered here
 * while the card stays, and the password never travels in the socket's broadcasts. The card
 * leaves when `approval_resolved` arrives, on every device showing the chat.
 */
export function DbExecuteApprovalCard({ requestId, input }: { requestId: string; input: DbExecuteApprovalInput }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canApprove = !busy && (!input.passwordRequired || password.length > 0);

  const answer = async (approved: boolean) => {
    setBusy(true);
    setError(null);
    const body: DbApprovalAnswer = approved && input.passwordRequired ? { approved, password } : { approved };
    try {
      await api.post(`/api/db/ai-approvals/${encodeURIComponent(requestId)}`, body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border-2 border-warning/40 bg-warning/10 p-3 space-y-2 select-text">
      <div className="flex items-center gap-2 text-warning text-sm font-medium">
        <ShieldAlert className="size-4" />
        <span>Approve a database change</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {input.color && <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: input.color }} />}
        <span className="font-medium text-text-primary">{input.connectionName}</span>
        {input.database && <span className="font-mono text-text-secondary">/ {input.database}</span>}
        <span className="text-text-subtle">{DB_TYPE_LABELS[input.dbType] ?? input.dbType}{input.group ? ` · ${input.group}` : ""}</span>
        {input.readonly && (
          <span className="rounded px-1.5 py-0.5 text-[10px] bg-panel-2 text-text-3">readonly — lifted for this script only</span>
        )}
      </div>
      {input.reason && <p className="text-xs text-text-primary whitespace-pre-wrap">{input.reason}</p>}
      <pre className="text-xs font-mono text-text-secondary overflow-auto max-h-64 whitespace-pre-wrap break-all bg-background rounded p-2 border border-border">
        {input.sql}
      </pre>
      <p className="text-[11px] text-text-subtle">
        Runs once, in one transaction.
        {input.expectedRows != null && ` Rolled back unless exactly ${input.expectedRows} row${input.expectedRows === 1 ? "" : "s"} change.`}
      </p>
      <form
        className="flex flex-col gap-2 md:flex-row md:items-center"
        onSubmit={(e) => {
          e.preventDefault();
          if (canApprove) void answer(true);
        }}
      >
        {input.passwordRequired && (
          <Input
            type="password"
            autoComplete="current-password"
            placeholder="PPM password"
            aria-label="PPM password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={!!error}
            disabled={busy}
            className="h-11 md:h-8 md:max-w-56"
          />
        )}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={!canApprove}
            className="flex-1 md:flex-none h-11 md:h-8 px-4 rounded bg-warning text-white text-xs font-medium hover:bg-warning/80 transition-colors disabled:opacity-50"
          >
            Run once
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void answer(false)}
            className="flex-1 md:flex-none h-11 md:h-8 px-4 rounded border border-border text-text-primary text-xs font-medium hover:bg-panel-2 transition-colors disabled:opacity-50"
          >
            Decline
          </button>
        </div>
      </form>
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}
