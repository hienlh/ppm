/**
 * Where PPM's browser keeps its data, and the command line it is started with.
 *
 * The profile is PPM's own, one per database (`web-browser` for `ppm.db`, `web-browser.dev` for
 * `ppm.dev.db`), so a dev server never opens the live instance's logins — the same split the
 * avatars folder makes. It is never the user's Chrome profile and never the CocCoc profile the
 * Playwright MCP extension drives.
 */
import { join } from "node:path";
import { getPpmDir } from "../ppm-dir.ts";
import { getDbProfile } from "../db.service.ts";

export function webBrowserDataDir(): string {
  const profile = getDbProfile();
  return join(getPpmDir(), profile ? `web-browser.${profile}` : "web-browser");
}

export const webBrowserPaths = {
  profile: () => join(webBrowserDataDir(), "profile"),
  pidFile: () => join(webBrowserDataDir(), "chrome.pid.json"),
  tabsFile: () => join(webBrowserDataDir(), "tabs.json"),
  downloads: () => join(webBrowserDataDir(), "downloads"),
  uploads: () => join(webBrowserDataDir(), "uploads"),
};

export type CdpTransportKind = "pipe" | "port";

export interface LaunchArgsInput {
  profileDir: string;
  /** SOCKS5 port of PPM's egress guard; every connection of the browser goes through it. */
  egressPort: number;
  transport: CdpTransportKind;
  /** DevTools port on 127.0.0.1, for `transport: "port"`. */
  devtoolsPort?: number;
  audio: boolean;
}

/**
 * Flags are chosen so that nothing reaches the network except through the proxy:
 * - `socks5://` makes Chrome hand host names to the proxy rather than resolve them itself, and
 *   `<-loopback>` removes Chrome's built-in exemption that would send localhost around it.
 * - QUIC cannot be proxied over SOCKS5 TCP, and WebRTC UDP would leave beside the proxy.
 * - Media Router would scan the LAN for cast devices; extensions could carry their own proxy.
 * - `--mute-audio` keeps the host's speakers silent; sound is captured inside the page instead.
 */
export function chromeLaunchArgs(input: LaunchArgsInput): string[] {
  const args = [
    "--headless=new",
    `--user-data-dir=${input.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--proxy-server=socks5://127.0.0.1:${input.egressPort}`,
    "--proxy-bypass-list=<-loopback>",
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-features=MediaRouter,DialMediaRouteProvider,DnsOverHttps,AsyncDns",
    "--dns-prefetch-disable",
    "--deny-permission-prompts",
    "--disable-sync",
    "--password-store=basic",
    "--lang=vi-VN",
    "--mute-audio",
    // Pages play and the sound tap runs without waiting for a gesture on the host, where nobody is.
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1280,800",
  ];
  if (input.transport === "pipe") {
    args.push("--remote-debugging-pipe");
  } else {
    if (!input.devtoolsPort) throw new Error("a DevTools port is required for the port transport");
    args.push("--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${input.devtoolsPort}`);
  }
  args.push("about:blank");
  return args;
}

/** Pipe where the runtime can hand a child fd 3/4; Bun on Windows cannot (see cdp-connection.ts). */
export function preferredTransport(platform: NodeJS.Platform = process.platform): CdpTransportKind {
  if (process.env.PPM_WEB_BROWSER_CDP === "port" || process.env.PPM_WEB_BROWSER_CDP === "pipe") {
    return process.env.PPM_WEB_BROWSER_CDP;
  }
  return platform === "win32" ? "port" : "pipe";
}
