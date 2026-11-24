/**
 * The small panels the toolbar opens: what "On host" means, downloads, the menu, and the
 * page's file chooser. A dropdown-sized card on desktop, a bottom sheet on a phone.
 */
import { WB_TEXT_BUTTON_OUTLINE, WB_TEXT_BUTTON_PRIMARY } from "./web-browser-button-styles";
import { useRef } from "react";
import { Download, ExternalLink, Trash2, Upload, Volume2, VolumeX, X } from "@/lib/icons";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { api, getAuthToken } from "@/lib/api-client";
import type { WebBrowserViewState } from "./use-web-browser-connection";

export type PanelKind = "info" | "downloads" | "menu" | "tabs" | null;

const row = "flex w-full items-center gap-2 rounded-md px-3 py-2 md:py-1.5 text-sm text-left hover:bg-panel-2 disabled:opacity-40 [&_svg]:size-4";

export function PanelFrame(p: { phone: boolean; onClose(): void; children: React.ReactNode; title?: string }) {
  if (p.phone) {
    return (
      <BottomSheet open onClose={p.onClose}>
        {p.title && <div className="px-3 pb-2 text-sm font-semibold">{p.title}</div>}
        <div className="flex flex-col gap-1 pb-2">{p.children}</div>
      </BottomSheet>
    );
  }
  return (
    <>
      <div className="absolute inset-0 z-20" onClick={p.onClose} />
      <div className="absolute right-2 top-11 z-30 w-80 rounded-lg border border-border bg-popover p-2 shadow-lg">
        {p.title && <div className="px-2 pb-1 text-xs font-semibold text-text-2">{p.title}</div>}
        <div className="flex flex-col gap-0.5">{p.children}</div>
      </div>
    </>
  );
}

export function InfoPanel(p: { s: WebBrowserViewState; latencyMs: number | null }) {
  return (
    <div className="flex flex-col gap-2 px-2 py-1 text-xs leading-relaxed text-text-2">
      <p><b className="text-text">Runs on the host, not on this device.</b> PPM shows the page as pictures and sends your mouse, keys and taps back.</p>
      <p>Round trip: <span className="font-mono">{p.latencyMs !== null ? `${p.latencyMs} ms` : "—"}</span>{p.s.ramMB ? ` · RAM ${p.s.ramMB} MB` : ""}</p>
      <p>Its own profile: it does not share logins with your Chrome, nor with AI chats' Playwright.</p>
      <p>It can open this machine's local services and devices on your network, if Settings allow it; PPM's own ports and cloud metadata addresses are always blocked.</p>
    </div>
  );
}

export function DownloadsPanel(p: { s: WebBrowserViewState }) {
  if (p.s.downloads.length === 0) return <div className="px-2 py-3 text-xs text-text-2">No downloads yet. Files stay on the host until you save them here.</div>;
  return (
    <>
      {p.s.downloads.map((d) => (
        <div key={d.id} className="flex items-center gap-2 px-2 py-1.5 text-sm">
          <Download className="size-4 text-text-3 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="truncate">{d.name}</div>
            <div className="text-xs text-text-3">{d.state === "done" ? formatBytes(d.sizeBytes ?? d.receivedBytes) : d.state === "canceled" ? "Canceled" : `${formatBytes(d.receivedBytes)}…`}</div>
          </div>
          {d.state === "done" && (
            <button type="button" className={WB_TEXT_BUTTON_PRIMARY}
              onClick={() => void saveDownload(d.id)}>Save</button>
          )}
        </div>
      ))}
    </>
  );
}

async function saveDownload(id: string): Promise<void> {
  // A one-use ticket: a plain link cannot carry PPM's Authorization header.
  const { url } = await api.post<{ url: string }>(`/api/web-browser/downloads/${encodeURIComponent(id)}/ticket`);
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  a.click();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function MenuPanel(p: { s: WebBrowserViewState; url: string | undefined; muted: boolean; onToggleMute(): void; onClear(): void; onCloseBrowser(): void }) {
  const http = p.url && /^https?:\/\//.test(p.url);
  return (
    <>
      {http ? (
        <a className={row} href={p.url} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-4" />Open in my browser</a>
      ) : (
        <button type="button" className={row} disabled><ExternalLink className="size-4" />Open in my browser</button>
      )}
      {p.s.audioAvailable && (
        <button type="button" className={row} onClick={p.onToggleMute}>
          {p.muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}{p.muted ? "Unmute" : "Mute"}
        </button>
      )}
      <button type="button" className={row} onClick={p.onClear}><Trash2 className="size-4" />Clear browsing data…</button>
      <button type="button" className={`${row} text-destructive`} onClick={p.onCloseBrowser}><X className="size-4" />Close the browser on the host</button>
    </>
  );
}

/** The page opened a file chooser: pick files here, upload them, hand them to the page. */
export function FileChooserPanel(p: { chooser: NonNullable<WebBrowserViewState["chooser"]>; onChosen(uploadIds: string[]): void; onCancel(): void }) {
  const input = useRef<HTMLInputElement>(null);
  const pick = async (files: FileList | null) => {
    if (!files?.length) return p.onCancel();
    const ids: string[] = [];
    for (const f of Array.from(files)) {
      // The body is the file itself, its name in a header: streamed to disk on the host.
      const token = getAuthToken();
      const res = await fetch("/api/web-browser/uploads", {
        method: "POST",
        body: f,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "X-File-Name": encodeURIComponent(f.name), "Content-Type": "application/octet-stream" },
      });
      const json = await res.json().catch(() => null) as { ok?: boolean; data?: { id: string } } | null;
      if (!res.ok || !json?.data?.id) return p.onCancel();
      ids.push(json.data.id);
    }
    p.onChosen(ids);
  };
  return (
    <div className="flex flex-col gap-2 px-2 py-1 text-sm">
      <div className="text-xs text-text-2">The page wants {p.chooser.multiple ? "files" : "a file"} from you.</div>
      <input ref={input} type="file" className="hidden" multiple={p.chooser.multiple} accept={p.chooser.accept || undefined}
        onChange={(e) => void pick(e.target.files)} />
      <button type="button" className={WB_TEXT_BUTTON_PRIMARY} onClick={() => input.current?.click()}>
        <Upload className="size-4" />Choose from this device
      </button>
      <button type="button" className={WB_TEXT_BUTTON_OUTLINE} onClick={p.onCancel}>Cancel</button>
    </div>
  );
}
