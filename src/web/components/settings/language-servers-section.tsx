/**
 * Language servers, for the whole machine.
 *
 * The editor already offers Install on the file that has no server, which is where the need is
 * usually noticed. This pane is the other half of the same question: what *does* this machine
 * have, and can I set a language up before opening a file in it — with one place that says
 * where the installs go and how to undo them.
 *
 * It asks `/api/lsp/servers`, which is deliberately machine-wide: no project is open here, so a
 * project's own `node_modules/.bin` is not consulted and rust-analyzer lands in the default
 * toolchain. A repository pinning its own toolchain is still served by the editor's button,
 * which runs rustup inside that project.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Download, Loader2, Trash2, Zap } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { api } from "@/lib/api-client";
import { useSettingsStore } from "@/stores/settings-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useIsTouchOnly } from "@/hooks/use-is-touch-only";
import { toast } from "sonner";

interface ServerRow {
  id: string;
  displayName: string;
  languages: string[];
  installed: boolean;
  installHint: string;
  /** Whether PPM can install this one *here* — a toolchain install needs that toolchain. */
  installable: boolean;
  installWith?: "bun" | "go" | "rustup";
  /** Where it was found. A server PPM did not put there is not PPM's to remove. */
  origin?: "project" | "rustup" | "path" | "ppm" | "bundled";
  removable: boolean;
  /** The other servers this removal would take with it, when one package provides several. */
  alsoRemoves?: string[];
}

interface ServersResponse {
  servers: ServerRow[];
  installDir: string;
  running: Array<{ serverId: string; rootPath: string; state: string; subscribers: number }>;
}

export function LanguageServersSection() {
  const [data, setData] = useState<ServersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ServerRow | null>(null);
  const lspEnabled = useSettingsStore((s) => s.lspEnabled);
  const setLspEnabled = useSettingsStore((s) => s.setLspEnabled);
  const isMobile = useIsMobile();
  // A device test, not the 768px viewport one: narrowing a desktop window must not disable the
  // setting and tell the user they are on a phone.
  const isTouchOnly = useIsTouchOnly();

  const load = useCallback(async () => {
    try {
      setData(await api.get<ServersResponse>("/api/lsp/servers"));
    } catch (e) {
      console.error("Failed to load language servers:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const install = async (server: ServerRow) => {
    setInstallingId(server.id);
    try {
      await api.post("/api/lsp/install", { serverId: server.id });
      toast.success(`Installed ${server.displayName}`);
      await load();
      // The editors that are already open said "not installed"; this is what spares them a
      // reopened tab. Dynamically, because a static import of the LSP client from anywhere in
      // `src/web` merges it back into the editor's chunk — see the lazy-boundary test.
      const lsp = await import("@/lib/lsp/lsp-client");
      lsp.retryUnavailableLspDocuments();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Could not install ${server.displayName}`);
    } finally {
      setInstallingId(null);
    }
  };

  const remove = async (server: ServerRow) => {
    setConfirming(null);
    setRemovingId(server.id);
    try {
      await api.post("/api/lsp/uninstall", { serverId: server.id });
      toast.success(`Removed ${[server.displayName, ...(server.alsoRemoves ?? [])].join(", ")}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Could not remove ${server.displayName}`);
    } finally {
      setRemovingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const servers = data?.servers ?? [];
  const runningIds = new Set((data?.running ?? []).map((r) => r.serverId));
  const busy = installingId !== null || removingId !== null;
  const installedCount = servers.filter((s) => s.installed).length;

  return (
    <div className="space-y-4">
      {/* The master switch lives here rather than under Appearance: this is the pane about
          language servers, and a server installed while the feature is off does nothing. */}
      <section className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Zap className="size-4 text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium">Language Server</p>
            <p className="text-xs text-muted-foreground">
              {isTouchOnly
                ? "Off on a touch device — it runs a server process per project"
                : "Completions, hover, F12, rename and quick fix (this device)"}
            </p>
          </div>
        </div>
        <Switch checked={lspEnabled && !isTouchOnly} disabled={isTouchOnly} onCheckedChange={setLspEnabled} />
      </section>

      <Separator />

      <section className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">
          Servers ({installedCount} of {servers.length} installed)
        </h3>
        <p className="text-[11px] text-muted-foreground">
          PPM installs into <span className="font-mono">{data?.installDir}</span>, so nothing you
          installed yourself changes — and Remove undoes exactly that, which is why a server PPM
          did not put there has no Remove. rust-analyzer is the exception: it is a rustup
          component, added to and removed from this machine's default toolchain. A server only
          starts when a file it serves is open.
        </p>

        <div className="space-y-1">
          {servers.map((server) => (
            <ServerRowItem
              key={server.id}
              server={server}
              running={runningIds.has(server.id)}
              installing={installingId === server.id}
              removing={removingId === server.id}
              busy={busy}
              isMobile={isMobile}
              onInstall={() => install(server)}
              onRemove={() => setConfirming(server)}
            />
          ))}
        </div>
      </section>

      {confirming && (
        <RemoveServerConfirm
          server={confirming}
          onConfirm={() => remove(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

function ServerRowItem({
  server, running, installing, removing, busy, isMobile, onInstall, onRemove,
}: {
  server: ServerRow;
  running: boolean;
  installing: boolean;
  removing: boolean;
  busy: boolean;
  isMobile: boolean;
  onInstall: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-muted/50">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium truncate">
          {server.displayName}
          {running && <span className="ml-1.5 text-[11px] text-success">running</span>}
        </p>
        <p className="text-[11px] text-muted-foreground truncate">{server.languages.join(", ")}</p>
      </div>

      {server.installed ? (
        <div className="flex items-center gap-1 shrink-0">
          {/* Where it came from, rather than a flat "Installed" — it is the whole reason some
              rows have a Remove and others do not. */}
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Check className="size-3.5 text-success" />
            {originLabel(server.origin)}
          </span>
          {server.removable && (
            <Button
              variant="ghost"
              size="icon"
              disabled={busy}
              onClick={onRemove}
              title={`Remove ${server.displayName}`}
              aria-label={`Remove ${server.displayName}`}
              className={`text-error cursor-pointer ${isMobile ? "size-11" : "size-8"}`}
            >
              {removing ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
            </Button>
          )}
        </div>
      ) : server.installable ? (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={onInstall}
          className={`text-xs px-3 gap-1 cursor-pointer shrink-0 ${isMobile ? "min-h-11" : "h-8"}`}
        >
          {installing ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />}
          Install
        </Button>
      ) : (
        // No toolchain here, or a system package manager: the command is all PPM can offer,
        // and a button that cannot work would be worse than none.
        <CopyHint hint={server.installHint} isMobile={isMobile} />
      )}
    </div>
  );
}

/**
 * What "installed" means for this row.
 *
 * A server PPM found rather than installed says so, because the alternative — a flat
 * "Installed" beside a Remove button that only some rows have — reads as a missing button.
 */
function originLabel(origin: ServerRow["origin"]): string {
  switch (origin) {
    case "project":
      return "In project";
    case "path":
      return "On PATH";
    case "bundled":
      return "Bundled";
    default:
      return "Installed";
  }
}

/**
 * Confirmation before removing a server.
 *
 * Worth asking for two reasons that the button alone cannot show. One npm package can provide
 * several servers — `vscode-langservers-extracted` is JSON, HTML and CSS — so Remove on one row
 * takes three, and that has to be said before rather than discovered after. And rust-analyzer
 * leaves the *toolchain*, which is the one removal that reaches outside PPM's own folder.
 *
 * Bottom sheet below `md`, centered dialog above — the shell `account-delete-confirm.tsx` uses.
 */
function RemoveServerConfirm({ server, onConfirm, onCancel }: {
  server: ServerRow;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const isMobile = useIsMobile();
  const also = server.alsoRemoves ?? [];

  const body = (
    <div className="space-y-4" data-testid="lsp-remove-confirm">
      <p className="text-sm">
        Remove <span className="font-medium">{server.displayName}</span>?
      </p>
      {also.length > 0 && (
        <p className="text-xs text-error">
          {also.join(" and ")} {also.length > 1 ? "come" : "comes"} from the same npm package, so{" "}
          {also.length > 1 ? "they go" : "it goes"} too.
        </p>
      )}
      <p className="text-xs text-text-subtle">{removeNote(server.installWith)}</p>
      <div className="flex flex-col-reverse md:flex-row gap-2 md:justify-end pt-2">
        <Button variant="outline" onClick={onCancel} className="min-h-11 cursor-pointer">
          Cancel
        </Button>
        <Button variant="destructive" autoFocus={false} onClick={onConfirm} className="min-h-11 cursor-pointer">
          Remove
        </Button>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <BottomSheet open onClose={onCancel}>
        <div className="px-4 pb-4">
          <h2 className="text-base font-semibold mb-3">Remove {server.displayName}</h2>
          {body}
        </div>
      </BottomSheet>
    );
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Remove {server.displayName}</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}

function removeNote(installWith: ServerRow["installWith"]): string {
  switch (installWith) {
    case "rustup":
      return "Runs rustup component remove, so it leaves this machine's default toolchain rather"
        + " than a folder of PPM's. Installing it again is one press of the button.";
    case "go":
      return "Deletes the binary PPM built in its own folder. Anything in your own GOBIN is"
        + " untouched.";
    default:
      return "Runs bun remove in PPM's own folder. Nothing you installed yourself changes, and a"
        + " server already running keeps running until its last editor closes.";
  }
}

function CopyHint({ hint, isMobile }: { hint: string; isMobile: boolean }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      title={hint}
      onClick={() => {
        void navigator.clipboard?.writeText(hint).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className={`flex items-center gap-1.5 max-w-40 sm:max-w-64 rounded border border-border px-2 font-mono text-[11px] text-muted-foreground hover:bg-muted active:scale-[0.99] transition cursor-pointer shrink-0 ${
        isMobile ? "min-h-11" : "py-1"
      }`}
    >
      <span className="truncate">{hint}</span>
      {copied ? <Check className="size-3 shrink-0 text-success" /> : <Copy className="size-3 shrink-0 opacity-60" />}
    </button>
  );
}
