import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, Power, PowerOff, Puzzle, FolderSymlink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { toast } from "sonner";

interface ExtensionInfo {
  id: string;
  version: string;
  displayName: string;
  description: string;
  icon: string;
  enabled: boolean;
  activated: boolean;
}

export function ExtensionManagerSection() {
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [installName, setInstallName] = useState("");
  const [installing, setInstalling] = useState(false);
  const [devPath, setDevPath] = useState("");
  const [showDevLink, setShowDevLink] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchExtensions = useCallback(async () => {
    try {
      const data = await api.get<ExtensionInfo[]>("/api/extensions");
      setExtensions(data);
    } catch (e) {
      console.error("Failed to load extensions:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchExtensions(); }, [fetchExtensions]);

  const handleInstall = async () => {
    const name = installName.trim();
    if (!name) return;
    setInstalling(true);
    try {
      await api.post("/api/extensions/install", { name });
      toast.success(`Installed ${name}`);
      setInstallName("");
      fetchExtensions();
    } catch (e: any) {
      toast.error(e.message || "Install failed");
    } finally {
      setInstalling(false);
    }
  };

  const handleToggle = async (ext: ExtensionInfo) => {
    setTogglingId(ext.id);
    try {
      await api.patch(`/api/extensions/${ext.id}`, { enabled: !ext.enabled });
      fetchExtensions();
    } catch (e: any) {
      toast.error(e.message || "Toggle failed");
    } finally {
      setTogglingId(null);
    }
  };

  const handleRemove = async (id: string) => {
    setDeletingId(id);
    try {
      await api.del(`/api/extensions/${id}`);
      toast.success(`Removed ${id}`);
      fetchExtensions();
    } catch (e: any) {
      toast.error(e.message || "Remove failed");
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Install */}
      <section className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">Install Extension</h3>
        <div className="flex gap-1.5">
          <Input
            value={installName}
            onChange={(e) => setInstallName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleInstall(); }}
            placeholder="npm package name (e.g. @ppm/ext-database)"
            className="h-8 text-xs flex-1"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs px-3 gap-1 cursor-pointer"
            disabled={!installName.trim() || installing}
            onClick={handleInstall}
          >
            {installing ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
            Install
          </Button>
        </div>
        <button
          onClick={() => setShowDevLink(!showDevLink)}
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          {showDevLink ? "Hide" : "Dev link local extension..."}
        </button>
        {showDevLink && (
          <div className="flex gap-1.5">
            <Input
              value={devPath}
              onChange={(e) => setDevPath(e.target.value)}
              placeholder="Local path (e.g. ./packages/ext-database)"
              className="h-8 text-xs flex-1"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs px-3 gap-1 cursor-pointer"
              disabled={!devPath.trim()}
              onClick={async () => {
                try {
                  await api.post("/api/extensions/dev-link", { path: devPath.trim() });
                  toast.success("Dev-linked successfully");
                  setDevPath("");
                  fetchExtensions();
                } catch (e: any) {
                  toast.error(e.message || "Dev link failed");
                }
              }}
            >
              <FolderSymlink className="size-3" />
              Link
            </Button>
          </div>
        )}
      </section>

      {/* Extension list */}
      <section className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">
          Installed ({extensions.length})
        </h3>
        {extensions.length === 0 ? (
          <p className="text-[11px] text-muted-foreground py-4 text-center">
            No extensions installed
          </p>
        ) : (
          <div className="space-y-1">
            {extensions.map((ext) => (
              <div
                key={ext.id}
                className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
              >
                <div className="size-8 rounded-md bg-background flex items-center justify-center shrink-0">
                  <Puzzle className="size-4 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{ext.displayName || ext.id}</p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {ext.id} v{ext.version}
                    {ext.activated && <span className="ml-1 text-green-500">active</span>}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 cursor-pointer"
                  title={ext.enabled ? "Disable" : "Enable"}
                  disabled={togglingId === ext.id}
                  onClick={() => handleToggle(ext)}
                >
                  {togglingId === ext.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : ext.enabled ? (
                    <Power className="size-3.5 text-green-500" />
                  ) : (
                    <PowerOff className="size-3.5 text-muted-foreground" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 cursor-pointer text-destructive hover:text-destructive"
                  title="Remove"
                  disabled={deletingId === ext.id}
                  onClick={() => handleRemove(ext.id)}
                >
                  {deletingId === ext.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="size-3.5" />
                  )}
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
