/**
 * Settings → PPM Assistant → Permissions, under Full mode: the saved database connections the
 * Assistant may write to without a card. Everything else still asks before a write. Only
 * connections open to the AI chat are listed; a read-only one is shown and cannot be ticked,
 * because PPM never writes through it at all. Each tick saves at once.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { patchAssistantSettings } from "@/lib/assistant-settings-api";
import type { Connection } from "@/components/database/use-connections";

export const DB_WRITE_LABEL = "Database writes without a card";
export const DB_WRITE_HINT = "Tick a connection to let the Assistant write to it without asking, in turns you start. Every other connection still shows a card first.";

/**
 * `initial` is the parent's copy of the saved list, and `onSaved` keeps it current: the list
 * unmounts when the mode leaves Full, and a remount from a stale copy would show (and on the next
 * tick save back) a connection the user had just un-ticked.
 */
export function AssistantDbWriteConnections({ initial, onSaved }: { initial: readonly number[]; onSaved: (ids: number[]) => void }) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [ticked, setTicked] = useState<Set<number>>(() => new Set(initial));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    api.get<Connection[]>("/api/db/connections")
      .then((list) => { if (live) setConnections(list.filter((c) => c.ai_access !== 0)); })
      .catch(() => { if (live) setConnections([]); });
    return () => { live = false; };
  }, []);

  const toggle = async (id: number, on: boolean) => {
    const next = new Set(ticked);
    if (on) next.add(id); else next.delete(id);
    setSaving(true);
    try {
      const res = await patchAssistantSettings({ db_write_connections: [...next] });
      const savedIds = res.settings.db_write_connections ?? [];
      setTicked(new Set(savedIds));
      onSaved(savedIds);
    } catch (e) {
      toast.error("Could not save", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="px-3.5 py-2.5" data-testid="assistant-db-write">
      <div className="text-sm">{DB_WRITE_LABEL}</div>
      <small className="mt-0.5 block text-xs leading-snug text-text-subtle">{DB_WRITE_HINT}</small>
      {connections === null ? null : connections.length === 0 ? (
        <p className="mt-2 text-xs text-text-subtle">No saved connection is open to the AI chat.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {connections.map((c) => {
            const id = `db-write-${c.id}`;
            const readonly = c.readonly === 1;
            return (
              <li key={c.id} className="flex min-w-0 items-center gap-2">
                <input
                  type="checkbox" id={id} disabled={readonly || saving}
                  checked={!readonly && ticked.has(c.id)}
                  onChange={(e) => void toggle(c.id, e.target.checked)}
                  className="size-3.5 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed"
                />
                <label htmlFor={id} className="min-w-0 truncate text-xs">
                  {c.name}
                  <span className="text-text-subtle"> · {c.type}{c.group_name ? ` · ${c.group_name}` : ""}{readonly ? " · read-only" : ""}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
