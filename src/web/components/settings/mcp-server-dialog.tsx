import { useState, useEffect } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { addMcpServer, updateMcpServer, type McpServerEntry } from "@/lib/api-mcp";
import { validateMcpName, validateMcpConfig, type McpTransportType } from "../../../types/mcp";

interface Props {
  open: boolean;
  onClose: (saved?: boolean) => void;
  editServer: McpServerEntry | null;
}

const TRANSPORTS: McpTransportType[] = ["stdio", "http", "sse"];

export function McpServerDialog({ open, onClose, editServer }: Props) {
  const isEdit = !!editServer;
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpTransportType>("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [kvPairs, setKvPairs] = useState<Array<{ key: string; value: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when dialog opens
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaving(false);
    if (editServer) {
      setName(editServer.name);
      setTransport((editServer.transport as McpTransportType) || "stdio");
      const c = editServer.config;
      if ("command" in c) {
        setCommand(c.command || "");
        setArgs((c.args ?? []).join(" "));
        setKvPairs(objToKv(c.env));
      } else if ("url" in c) {
        setUrl(c.url || "");
        setKvPairs(objToKv(c.headers));
      }
    } else {
      setName(""); setTransport("stdio"); setCommand(""); setArgs(""); setUrl("");
      setKvPairs([]);
    }
  }, [open, editServer]);

  const buildConfig = () => {
    const kv = kvToObj(kvPairs);
    if (transport === "stdio") {
      return {
        type: "stdio" as const,
        command,
        ...(args.trim() && { args: args.trim().split(/\s+/) }),
        ...(Object.keys(kv).length > 0 && { env: kv }),
      };
    }
    return {
      type: transport,
      url,
      ...(Object.keys(kv).length > 0 && { headers: kv }),
    };
  };

  const handleSave = async () => {
    setError(null);
    if (!isEdit) {
      const nameErr = validateMcpName(name);
      if (nameErr) { setError(nameErr); return; }
    }
    const config = buildConfig();
    const configErrs = validateMcpConfig(config);
    if (configErrs.length) { setError(configErrs.join("; ")); return; }

    setSaving(true);
    try {
      if (isEdit) {
        await updateMcpServer(name, config);
      } else {
        await addMcpServer(name, config);
      }
      onClose(true);
    } catch (e: any) {
      setError(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const addKvPair = () => setKvPairs([...kvPairs, { key: "", value: "" }]);
  const removeKvPair = (i: number) => setKvPairs(kvPairs.filter((_, idx) => idx !== i));
  const updateKv = (i: number, field: "key" | "value", val: string) => {
    setKvPairs(kvPairs.map((p, idx) =>
      idx === i ? { key: field === "key" ? val : p.key, value: field === "value" ? val : p.value } : p
    ));
  };

  const isStdio = transport === "stdio";
  const kvLabel = isStdio ? "Environment Variables" : "Headers";

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">{isEdit ? "Edit MCP Server" : "Add MCP Server"}</DialogTitle>
          <DialogDescription className="text-[11px]">
            Configure a Model Context Protocol server connection.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* Name */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">Name</label>
            <Input
              value={name} onChange={(e) => setName(e.target.value)}
              placeholder="my-mcp-server" className="h-8 text-xs" disabled={isEdit}
            />
          </div>

          {/* Transport toggle */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">Transport</label>
            <div className="flex gap-1">
              {TRANSPORTS.map((t) => (
                <Button key={t} variant={transport === t ? "default" : "outline"}
                  size="sm" className="flex-1 h-7 text-xs cursor-pointer"
                  onClick={() => { setTransport(t); setKvPairs([]); setCommand(""); setArgs(""); setUrl(""); }}
                >{t}</Button>
              ))}
            </div>
          </div>

          {/* Conditional fields */}
          {isStdio ? (
            <>
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-muted-foreground">Command *</label>
                <Input value={command} onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx" className="h-8 text-xs" />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-muted-foreground">Arguments (space-separated)</label>
                <Input value={args} onChange={(e) => setArgs(e.target.value)}
                  placeholder="@playwright/mcp@latest" className="h-8 text-xs" />
              </div>
            </>
          ) : (
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">URL *</label>
              <Input value={url} onChange={(e) => setUrl(e.target.value)}
                placeholder="https://mcp.example.com" className="h-8 text-xs" />
            </div>
          )}

          {/* Key-value pairs */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground">{kvLabel}</label>
            {kvPairs.map((pair, i) => (
              <div key={i} className="flex gap-1 items-center">
                <Input value={pair.key} onChange={(e) => updateKv(i, "key", e.target.value)}
                  placeholder="KEY" className="h-7 text-xs flex-1" />
                <Input value={pair.value} onChange={(e) => updateKv(i, "value", e.target.value)}
                  placeholder="value" className="h-7 text-xs flex-1" />
                <Button variant="ghost" size="icon" className="size-7 shrink-0 cursor-pointer"
                  onClick={() => removeKvPair(i)}>
                  <X className="size-3" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1 cursor-pointer" onClick={addKvPair}>
              <Plus className="size-3" /> Add {isStdio ? "Variable" : "Header"}
            </Button>
          </div>

          {error && <p className="text-[11px] text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8 text-xs cursor-pointer" onClick={() => onClose()}>
            Cancel
          </Button>
          <Button size="sm" className="h-8 text-xs cursor-pointer" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function objToKv(obj?: Record<string, string>): Array<{ key: string; value: string }> {
  if (!obj) return [];
  return Object.entries(obj).map(([key, value]) => ({ key, value }));
}

function kvToObj(pairs: Array<{ key: string; value: string }>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const { key, value } of pairs) {
    if (key.trim()) result[key.trim()] = value;
  }
  return result;
}
