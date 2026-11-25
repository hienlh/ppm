/**
 * Settings → Web Browser: PPM's own Chrome on this host. On/off, which installed browser runs,
 * limits that keep its memory in check, picture quality, sound, AI control, and the three
 * reach switches — each warned about, and warned about together when they stack.
 */
import { WB_TEXT_BUTTON_OUTLINE } from "@/components/web-browser/web-browser-button-styles";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Globe } from "@/lib/icons";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import { AUTO_FPS_CAP, WEB_BROWSER_QUALITY_PRESETS, type WebBrowserSettings } from "../../../shared/web-browser-settings";
import { refreshWebBrowserAvailable } from "@/components/web-browser/use-web-browser-available";
import { openWebBrowser } from "@/components/web-browser/open-web-browser";

interface Caps {
  available: boolean;
  browsers: { path: string; name: string; version: string }[];
  installHint: string | null;
  publicRequest: boolean;
  state: string;
  settings: WebBrowserSettings;
}

function Row(p: { title: string; body?: React.ReactNode; checked: boolean; disabled?: boolean; onChange(v: boolean): void }) {
  return (
    <label className="flex items-start gap-3 py-1.5 cursor-pointer">
      <div className="flex-1">
        <div className="text-sm">{p.title}</div>
        {p.body && <div className="text-xs text-muted-foreground leading-relaxed">{p.body}</div>}
      </div>
      <Switch checked={p.checked} disabled={p.disabled} onCheckedChange={p.onChange} className="mt-1" />
    </label>
  );
}

const warn = "flex gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs leading-relaxed";

export function WebBrowserSettingsSection() {
  const [caps, setCaps] = useState<Caps | null>(null);
  const load = useCallback(async () => {
    try { setCaps(await api.get<Caps>("/api/web-browser/capabilities")); } catch {}
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async (patch: Partial<WebBrowserSettings>) => {
    if (!caps) return;
    try {
      const settings = await api.put<WebBrowserSettings>("/api/web-browser/settings", { ...caps.settings, ...patch });
      setCaps({ ...caps, settings });
      refreshWebBrowserAvailable();
    } catch (e) {
      toast.error("Could not save", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  if (!caps) return <div className="text-sm text-muted-foreground">Loading…</div>;
  const s = caps.settings;
  const locked = caps.publicRequest; // reach switches cannot be widened from a public link
  const preset = s.autoFps ? "auto" : (Object.entries(WEB_BROWSER_QUALITY_PRESETS).find(([, p]) => p.fpsCap === s.fpsCap && p.jpegQuality === s.jpegQuality)?.[0]) ?? "custom";

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div>
          <h3 className="text-sm font-medium">Web browser</h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            A Chrome that runs on this host, shown in a PPM window (a tab on a phone). It uses its own
            profile: no logins shared with your Chrome or with AI chats' Playwright.
          </p>
        </div>
        <Row title="Turn on the web browser" checked={s.enabled === true} onChange={(v) => void save({ enabled: v })} />
        {s.enabled === true && <button type="button" className={WB_TEXT_BUTTON_OUTLINE} onClick={openWebBrowser}><Globe />Open the browser</button>}
        {caps.browsers.length === 0 ? (
          <p className={warn}><AlertTriangle className="size-4 shrink-0" />No Chrome or Edge found on this host. {caps.installHint}</p>
        ) : (
          <label className="flex items-center gap-3 py-1 text-sm">
            <span className="flex-1">Browser on this host</span>
            <select className="min-h-9 rounded-md border border-border bg-panel px-2 text-sm" disabled={locked}
              value={s.browserPath ?? caps.browsers[0]!.path} onChange={(e) => void save({ browserPath: e.target.value })}>
              {caps.browsers.map((b) => <option key={b.path} value={b.path}>{b.name} {b.version}</option>)}
            </select>
          </label>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Memory</h3>
        <label className="flex items-center gap-3 py-1 text-sm">
          <span className="flex-1">Most tabs at once <span className="text-xs text-muted-foreground">(each page costs 100–500 MB)</span></span>
          <input type="number" min={1} max={8} value={s.maxTabs} onChange={(e) => void save({ maxTabs: Number(e.target.value) })} className="w-20 min-h-9 rounded-md border border-border bg-panel px-2" />
        </label>
        <label className="flex items-center gap-3 py-1 text-sm">
          <span className="flex-1">Stop the browser after this many minutes unused</span>
          <input type="number" min={2} max={120} value={s.idleStopMinutes} onChange={(e) => void save({ idleStopMinutes: Number(e.target.value) })} className="w-20 min-h-9 rounded-md border border-border bg-panel px-2" />
        </label>
        <label className="flex items-center gap-3 py-1 text-sm">
          <span className="flex-1">Picture <span className="text-xs text-muted-foreground">(more frames cost more bandwidth)</span></span>
          <select value={preset} onChange={(e) => {
            if (e.target.value === "auto") return void save({ autoFps: true });
            const p = WEB_BROWSER_QUALITY_PRESETS[e.target.value as keyof typeof WEB_BROWSER_QUALITY_PRESETS];
            if (p) void save(p);
          }}
            className="min-h-9 rounded-md border border-border bg-panel px-2 text-sm">
            <option value="auto">Auto (up to {AUTO_FPS_CAP} fps, follows the connection)</option>
            <option value="saver">Saver (8 fps)</option>
            <option value="balanced">Balanced (12 fps)</option>
            <option value="smooth">Smooth (20 fps)</option>
            {preset === "custom" && <option value="custom">Custom ({s.fpsCap} fps)</option>}
          </select>
        </label>
        <Row title="Sound" body="Pages' sound plays on the device you view from; the host's speakers stay silent." checked={s.audio} onChange={(v) => void save({ audio: v })} />
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">What it may reach</h3>
        {locked && <p className={warn}><AlertTriangle className="size-4 shrink-0" />You are on a public link: these can only be changed from the LAN or Tailscale.</p>}
        <Row title="Services on this machine (localhost)" disabled={locked} checked={s.allowLocalhost}
          body="Dev servers and local tools. PPM's own ports are always blocked." onChange={(v) => void save({ allowLocalhost: v })} />
        <Row title="Devices on your network (LAN)" disabled={locked} checked={s.allowLan}
          body="Router, NAS, printers. Cloud metadata addresses are always blocked." onChange={(v) => void save({ allowLan: v })} />
        <Row title="Use it over a public link" disabled={locked} checked={s.allowPublicTunnel}
          body="When off, the browser opens only from the LAN or Tailscale." onChange={(v) => void save({ allowPublicTunnel: v })} />
        <Row title="Let AI chats drive it" disabled={locked} checked={s.aiControl}
          body="Each chat asks you once before it first uses the browser; you can take it back at any time." onChange={(v) => void save({ aiControl: v })} />
        {s.allowPublicTunnel && (s.allowLocalhost || s.allowLan) && (
          <p className={warn}><AlertTriangle className="size-4 shrink-0" />
            With a public link on, anyone holding PPM's password over the Internet can use this browser to open
            {s.allowLocalhost && s.allowLan ? " this machine's local services and the devices on your home network" : s.allowLocalhost ? " this machine's local services" : " the devices on your home network"}.
          </p>
        )}
        {s.aiControl && <p className={warn}><AlertTriangle className="size-4 shrink-0" />A page can try to talk an AI into clicking things on sites this browser is signed in to.</p>}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Data</h3>
        <button type="button" className={WB_TEXT_BUTTON_OUTLINE} onClick={async () => {
          if (!window.confirm("Clear the browser's logins, history and downloads on the host?")) return;
          await api.post("/api/web-browser/clear-data");
          toast.success("Browsing data cleared");
        }}>Clear browsing data…</button>
      </section>
    </div>
  );
}
