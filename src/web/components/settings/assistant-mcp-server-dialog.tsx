import { useEffect, useState } from "react";
import { Plus, X } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DesignResponsiveDialog } from "@/components/design/dialogs/design-responsive-dialog";
import {
  foldMcpName, readAssistantSettings, type AssistantMcpServer,
} from "../../../shared/assistant-settings";

type Pair = { key: string; value: string };

const FIELD = "space-y-1";
const LABEL = "text-xs font-medium text-text-subtle";

/**
 * Add or edit one of the Assistant's MCP servers. Env and header values are secrets the browser
 * never receives: a saved one shows as a placeholder, and leaving it blank keeps it.
 */
export function AssistantMcpServerDialog({ open, server, savedKeys, takenNames, onClose, onDone }: {
  open: boolean;
  /** The server being edited, or null to add one. */
  server: AssistantMcpServer | null;
  /** Env or header names with a value saved on the server, for this server. */
  savedKeys: ReadonlySet<string>;
  /** Names the other servers use, folded with {@link foldMcpName}. */
  takenNames: ReadonlySet<string>;
  onClose: () => void;
  onDone: (server: AssistantMcpServer) => void;
}) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(server?.name ?? "");
    setTransport(server?.transport ?? "stdio");
    setCommand(server?.transport === "stdio" ? server.command : "");
    setArgs(server?.transport === "stdio" ? server.args.join("\n") : "");
    setUrl(server?.transport === "http" ? server.url : "");
    const saved = server ? (server.transport === "stdio" ? server.env : server.headers) : {};
    setPairs(Object.entries(saved).map(([key, value]) => ({ key, value })));
  }, [open, server]);

  const stdio = transport === "stdio";
  const sameTransport = server?.transport === transport;

  const done = () => {
    const values = Object.fromEntries(pairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value]));
    const draft = stdio
      ? { id: server?.id ?? "", name: name.trim(), enabled: server?.enabled ?? true, transport, command, args: args.split("\n").map((a) => a.trim()).filter(Boolean), env: values }
      : { id: server?.id ?? "", name: name.trim(), enabled: server?.enabled ?? true, transport, url, headers: values };
    const { value, errors } = readAssistantSettings({ mcp_servers: [draft] });
    const missing = Object.entries(values).find(([key, val]) => !val && !(sameTransport && savedKeys.has(key)));
    if (errors.length) return setError(errors[0]!);
    if (takenNames.has(foldMcpName(draft.name))) return setError(`Another server is already named "${draft.name}"`);
    if (missing) return setError(`${missing[0]} needs a value`);
    onDone({ ...value.mcp_servers[0]!, id: draft.id });
  };

  const update = (i: number, patch: Partial<Pair>) => setPairs((all) => all.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  return (
    <DesignResponsiveDialog
      open={open}
      onClose={onClose}
      title={server ? "Edit MCP server" : "Add MCP server"}
      description="Only PPM Assistant sessions use this server. Every one of its tools asks you before it runs."
      footer={(
        <>
          <Button variant="outline" size="sm" className="md:h-8" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="md:h-8" onClick={done}>Done</Button>
        </>
      )}
    >
      <div className="space-y-3 px-0.5 pb-1">
        <div className={FIELD}>
          <label className={LABEL} htmlFor="asst-mcp-name">Name</label>
          <Input id="asst-mcp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="github" className="h-11 md:h-8" autoComplete="off" />
        </div>
        <div className={FIELD}>
          <span className={LABEL}>Transport</span>
          <div className="flex gap-2">
            {(["stdio", "http"] as const).map((t) => (
              <Button key={t} type="button" variant={transport === t ? "default" : "outline"} size="sm" className="h-11 flex-1 md:h-8"
                onClick={() => setTransport(t)}>{t === "stdio" ? "Command (stdio)" : "HTTP"}</Button>
            ))}
          </div>
        </div>
        {stdio ? (
          <>
            <div className={FIELD}>
              <label className={LABEL} htmlFor="asst-mcp-command">Command</label>
              <Input id="asst-mcp-command" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" className="h-11 md:h-8" />
            </div>
            <div className={FIELD}>
              <label className={LABEL} htmlFor="asst-mcp-args">Arguments, one per line</label>
              <textarea id="asst-mcp-args" rows={3} value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y&#10;@modelcontextprotocol/server-github"
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-xs" />
            </div>
          </>
        ) : (
          <div className={FIELD}>
            <label className={LABEL} htmlFor="asst-mcp-url">URL</label>
            <Input id="asst-mcp-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" className="h-11 md:h-8" />
          </div>
        )}
        <div className="space-y-2">
          <span className={LABEL}>{stdio ? "Environment variables" : "Headers"} (kept on the server, never shown again)</span>
          {pairs.map((pair, i) => {
            const saved = sameTransport && savedKeys.has(pair.key.trim());
            return (
              <div key={i} className="flex items-center gap-2">
                <Input value={pair.key} onChange={(e) => update(i, { key: e.target.value })} placeholder={stdio ? "NAME" : "Header"} aria-label="Name"
                  className="h-11 min-w-0 flex-1 md:h-8" autoComplete="off" />
                <Input type="password" value={pair.value} onChange={(e) => update(i, { value: e.target.value })} aria-label="Value"
                  placeholder={saved ? "•••••• saved — blank keeps it" : "value"} className="h-11 min-w-0 flex-1 md:h-8" autoComplete="new-password" />
                <Button variant="ghost" size="icon" aria-label="Remove" className="size-11 shrink-0 md:size-8"
                  onClick={() => setPairs((all) => all.filter((_, idx) => idx !== i))}>
                  <X className="size-4" />
                </Button>
              </div>
            );
          })}
          <Button variant="outline" size="sm" className="h-11 gap-1 md:h-8" onClick={() => setPairs((all) => [...all, { key: "", value: "" }])}>
            <Plus className="size-4" /> {stdio ? "Add variable" : "Add header"}
          </Button>
        </div>
        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      </div>
    </DesignResponsiveDialog>
  );
}
