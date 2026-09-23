import { useCallback, useEffect, useRef, useState } from "react";
import { KeyRound, Loader2, RefreshCw } from "@/lib/icons";
import { getMcpAuthStatus, type McpServerState } from "@/lib/api-mcp-auth";
import { McpSignInDialog } from "./mcp-sign-in-dialog";
import { isClaudeAiConnector } from "./claude-ai-connector";

/**
 * Where a server was configured, in words. "dynamic" — what the CLI calls every server
 * PPM hands it — says nothing to the reader, so it is left out.
 */
function originLabel(s: McpServerState): string | null {
  if (isClaudeAiConnector(s.name, s.scope)) return "claude.ai connector";
  if (s.source === "plugin") return "Plugin";
  if (s.scope && s.scope !== "dynamic") return s.scope;
  return null;
}

interface McpSignInListProps {
  /** Project whose MCP configuration applies; undefined = the home directory's. */
  project?: string;
  /** The panel's search box — the list filters with everything else. */
  search?: string;
  /** Keep the heading and say so when nothing needs a sign-in (Settings), instead of rendering nothing. */
  showWhenEmpty?: boolean;
}

/**
 * MCP servers that are configured but waiting for a sign-in, as a chat in `project` would
 * see them. Covers every source Claude loads — PPM's own list, ~/.claude.json and plugins —
 * which is why it asks the server instead of reading the PPM list next to it.
 */
export function McpSignInList({ project, search = "", showWhenEmpty = false }: McpSignInListProps) {
  const [servers, setServers] = useState<McpServerState[]>([]);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState<string | null>(null);

  // Only the latest request may write: switching projects quickly must not leave the
  // previous project's answer on screen.
  const seqRef = useRef(0);
  const load = useCallback(async (fresh = false) => {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const next = await getMcpAuthStatus(project, fresh);
      if (seq === seqRef.current) setServers(next);
    } catch {
      // A failed probe hides the list rather than showing a stale one.
      if (seq === seqRef.current) setServers([]);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [project]);

  useEffect(() => { void load(); }, [load]);

  const q = search.trim().toLowerCase();
  const pending = servers.filter((s) => s.status === "needs-auth" && (!q || s.name.toLowerCase().includes(q)));

  return (
    <>
      {(pending.length > 0 || showWhenEmpty) && (
        <div className="pb-1">
          <div className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
            <span>Needs sign-in</span>
            <span className="text-text-subtle/60">{pending.length}</span>
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={loading}
              className="ml-auto flex size-6 items-center justify-center rounded hover:bg-surface-elevated disabled:opacity-50 max-md:size-9"
              aria-label="Check again"
              title="Check again"
            >
              {loading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
            </button>
          </div>
          {pending.length === 0 && (
            <p className="px-2 py-1.5 text-[11px] text-text-subtle">
              {loading ? "Checking MCP servers…" : "No MCP server is waiting for a sign-in."}
            </p>
          )}
          {pending.map((s) => (
            <div key={s.name} className="flex items-center gap-2 px-2 py-1.5">
              <KeyRound className="size-4 shrink-0 text-warning" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{s.name}</span>
                {originLabel(s) && (
                  <span className="block truncate text-[11px] text-text-subtle">{originLabel(s)}</span>
                )}
              </span>
              <button
                type="button"
                onClick={() => setSigningIn(s.name)}
                className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 max-md:min-h-9 max-md:px-3"
              >
                {isClaudeAiConnector(s.name, s.scope) ? "Connect" : "Sign in"}
              </button>
            </div>
          ))}
        </div>
      )}
      <McpSignInDialog
        serverName={signingIn}
        project={project}
        onClose={() => setSigningIn(null)}
        onSignedIn={() => void load(true)}
      />
    </>
  );
}
