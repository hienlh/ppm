import { describe, it, expect } from "bun:test";
import {
  parseCloudflaredCmdline,
  extractMetricsPort,
  parseQuickTunnelResponse,
  mergeTunnelSources,
  withCurrentPpmTunnels,
  isAppTunnel,
  type TunnelEntry,
} from "../../../src/services/tunnel-registry-parse.ts";

describe("parseCloudflaredCmdline", () => {
  it("extracts target port from --url with http scheme", () => {
    const r = parseCloudflaredCmdline("cloudflared tunnel --url http://127.0.0.1:3000");
    expect(r.targetPort).toBe(3000);
  });

  it("extracts target port from --url=host:port form", () => {
    const r = parseCloudflaredCmdline("cloudflared tunnel --url=http://localhost:8080");
    expect(r.targetPort).toBe(8080);
  });

  it("extracts target port from bare host:port (no scheme)", () => {
    const r = parseCloudflaredCmdline("cloudflared tunnel --url 127.0.0.1:5173");
    expect(r.targetPort).toBe(5173);
  });

  it("extracts metrics addr", () => {
    const r = parseCloudflaredCmdline("cloudflared tunnel --url http://127.0.0.1:3000 --metrics 127.0.0.1:20241");
    expect(r.metricsAddr).toBe("127.0.0.1:20241");
  });

  it("extracts metrics addr from --metrics=host:port form", () => {
    const r = parseCloudflaredCmdline("cloudflared tunnel --metrics=127.0.0.1:45999 --url http://127.0.0.1:1");
    expect(r.metricsAddr).toBe("127.0.0.1:45999");
  });

  it("handles quoted Windows exe path", () => {
    const r = parseCloudflaredCmdline('"C:\\Users\\PC\\.ppm\\bin\\cloudflared.exe" tunnel --url http://127.0.0.1:9000');
    expect(r.targetPort).toBe(9000);
  });

  it("extracts run ref (named tunnel)", () => {
    const r = parseCloudflaredCmdline("cloudflared tunnel run my-prod-tunnel");
    expect(r.runRef).toBe("my-prod-tunnel");
  });

  it("NEVER captures a --token value as runRef (secret hygiene)", () => {
    const r = parseCloudflaredCmdline("cloudflared tunnel run --token eyJhbGciOiJ.SECRET.value");
    expect(r.runRef).toBeNull();
  });

  it("does not treat a --token value as a target port or leak it", () => {
    const r = parseCloudflaredCmdline("cloudflared tunnel run --token eyJ.abc:123.def");
    expect(r.targetPort).toBeNull();
    expect(r.runRef).toBeNull();
    expect(r.metricsAddr).toBeNull();
  });

  it("returns nulls when no recognized flags present", () => {
    const r = parseCloudflaredCmdline("cloudflared --help");
    expect(r).toEqual({ targetPort: null, metricsAddr: null, runRef: null });
  });
});

describe("extractMetricsPort", () => {
  it("returns port from host:port", () => {
    expect(extractMetricsPort("127.0.0.1:20241")).toBe(20241);
  });
  it("returns port from bare :port", () => {
    expect(extractMetricsPort(":20243")).toBe(20243);
  });
  it("returns null for null / malformed", () => {
    expect(extractMetricsPort(null)).toBeNull();
    expect(extractMetricsPort("nope")).toBeNull();
  });
});

describe("parseQuickTunnelResponse", () => {
  it("returns https URL from valid quicktunnel JSON", () => {
    const url = parseQuickTunnelResponse('{"hostname":"authentication-cake-arnold-alice.trycloudflare.com"}');
    expect(url).toBe("https://authentication-cake-arnold-alice.trycloudflare.com");
  });
  it("rejects non-trycloudflare hostnames (payload validation)", () => {
    expect(parseQuickTunnelResponse('{"hostname":"evil.example.com"}')).toBeNull();
  });
  it("returns null for non-JSON / missing hostname", () => {
    expect(parseQuickTunnelResponse("# HELP build_info")).toBeNull();
    expect(parseQuickTunnelResponse('{"foo":1}')).toBeNull();
  });
});

describe("mergeTunnelSources", () => {
  const ext = (pid: number, port: number | null): TunnelEntry => ({
    pid, port, url: null, source: "external", protected: false, status: "running",
  });
  const ppm = (pid: number, port: number, url: string): TunnelEntry => ({
    pid, port, url, source: "ppm", protected: false, status: "running",
  });
  const app = (pid: number, port: number, url: string): TunnelEntry => ({
    pid, port, url, source: "app", protected: true, status: "running",
  });

  it("dedupes by pid with precedence app > ppm > external", () => {
    const merged = mergeTunnelSources({
      external: [ext(100, 3000), ext(200, 4000)],
      ppm: [ppm(100, 3000, "https://a.trycloudflare.com")],
      app: [],
    });
    const byPid = Object.fromEntries(merged.map((t) => [t.pid, t]));
    expect(merged.length).toBe(2);
    expect(byPid[100]!.source).toBe("ppm");
    expect(byPid[100]!.url).toBe("https://a.trycloudflare.com");
    expect(byPid[200]!.source).toBe("external");
  });

  it("app precedence wins and preserves protected", () => {
    const merged = mergeTunnelSources({
      external: [ext(500, 8080)],
      ppm: [ppm(500, 8080, "https://x.trycloudflare.com")],
      app: [app(500, 8080, "https://x.trycloudflare.com")],
    });
    expect(merged.length).toBe(1);
    expect(merged[0]!.source).toBe("app");
    expect(merged[0]!.protected).toBe(true);
  });

  it("fills url/port from higher-precedence entry when external lacks it", () => {
    const merged = mergeTunnelSources({
      external: [ext(700, null)],
      ppm: [ppm(700, 9000, "https://y.trycloudflare.com")],
      app: [],
    });
    expect(merged[0]!.port).toBe(9000);
    expect(merged[0]!.url).toBe("https://y.trycloudflare.com");
  });
});

describe("withCurrentPpmTunnels (the process scan failed)", () => {
  const entry = (pid: number, source: TunnelEntry["source"], port: number | null = null): TunnelEntry => ({
    pid, port, url: null, source, protected: source === "app", status: "running",
  });

  it("lists a forward PPM started since the last good scan, with other programs' tunnels as last seen", () => {
    const served = withCurrentPpmTunnels([entry(10, "external", 3000), entry(20, "app", 8080)], [entry(30, "ppm", 5173)]);
    expect(served.map((t) => [t.pid, t.source]).sort()).toEqual([[10, "external"], [20, "app"], [30, "ppm"]]);
  });

  it("drops a PPM forward stopped since the last good scan", () => {
    const served = withCurrentPpmTunnels([entry(10, "external"), entry(40, "ppm", 4000)], []);
    expect(served.map((t) => t.pid)).toEqual([10]);
  });

  it("serves only PPM's own when no scan ever succeeded", () => {
    expect(withCurrentPpmTunnels([], [entry(30, "ppm", 5173)]).map((t) => t.pid)).toEqual([30]);
  });

  it("a pid now known as PPM's is listed once, as PPM's", () => {
    const served = withCurrentPpmTunnels([entry(50, "external", 6000)], [entry(50, "ppm", 6000)]);
    expect(served).toHaveLength(1);
    expect(served[0]!.source).toBe("ppm");
  });
});

describe("isAppTunnel", () => {
  const app = { shareUrl: "https://ppm.example.com", tunnelPid: 100, serverPort: 3214 };
  const base = (over: Partial<TunnelEntry>): TunnelEntry => ({
    pid: 1, port: null, url: null, source: "external", protected: false, status: "running", ...over,
  });

  it("protects the supervisor tunnel by pid", () => {
    expect(isAppTunnel(base({ pid: 100 }), app)).toBe(true);
  });

  it("protects by public URL even when the pid went stale", () => {
    expect(isAppTunnel(base({ pid: 999, url: "https://ppm.example.com" }), app)).toBe(true);
  });

  it("protects an unknown tunnel on the PPM port (stale-pid fallback)", () => {
    expect(isAppTunnel(base({ pid: 999, port: 3214 }), app)).toBe(true);
  });

  it("leaves a PPM-spawned temporary tunnel on the same port stoppable", () => {
    const temp = base({ pid: 777, port: 3214, url: "https://temp.trycloudflare.com", source: "ppm" });
    expect(isAppTunnel(temp, app)).toBe(false);
  });

  it("still protects a PPM-sourced entry that IS the supervisor tunnel", () => {
    const same = base({ pid: 100, port: 3214, source: "ppm" });
    expect(isAppTunnel(same, app)).toBe(true);
  });

  it("ignores unrelated tunnels", () => {
    expect(isAppTunnel(base({ pid: 5, port: 5173 }), app)).toBe(false);
  });
});
