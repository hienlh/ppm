import { describe, expect, test } from "bun:test";
import {
  buildSetupState,
  isApprovedHost,
  parsePrefs,
  serviceTarget,
  targetPort,
  type SetupInputs,
} from "../../../../src/services/tailscale/tailscale-state.ts";

/** The fields of a real `tailscale status --json` (1.102.4) on a tagged service host. */
const STATUS = {
  BackendState: "Running",
  MagicDNSSuffix: "tail1234.ts.net",
  CurrentTailnet: { Name: "user@example.com", MagicDNSSuffix: "tail1234.ts.net", MagicDNSEnabled: true },
  CertDomains: ["devbox.tail1234.ts.net", "ppm.tail1234.ts.net"],
  Self: {
    HostName: "devbox",
    DNSName: "devbox.tail1234.ts.net.",
    TailscaleIPs: ["100.74.55.81", "fd7a:115c:a1e0::3b36:3752"],
    Tags: ["tag:server"],
    CapMap: {
      "service-host": [{ "svc:ppm": ["100.103.128.169", "fd7a:115c:a1e0::8c2d:80aa"] }],
      "services/ppm": [{ Name: "svc:ppm", Addrs: ["100.103.128.169"], Ports: ["tcp:443"] }],
      "services/code": [{ Name: "svc:code", Addrs: ["100.127.147.53"], Ports: ["tcp:443"] }],
    },
  },
};

/** `tailscale serve status --json` with the service pointing at PPM. */
const SERVE = {
  TCP: { "443": { HTTPS: true } },
  Web: { "devbox.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3210" } } } },
  Services: {
    "svc:ppm": {
      TCP: { "443": { HTTPS: true } },
      Web: { "ppm.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3210" } } } },
    },
  },
};

/** `tailscale debug prefs`, keys included; PPM must keep none of them. */
const PREFS = {
  ControlURL: "https://controlplane.tailscale.com",
  OperatorUser: "dev",
  AdvertiseServices: ["svc:ppm"],
  AdvertiseTags: ["tag:server"],
  Config: { PrivateNodeKey: "privkey:secret", NetworkLockKey: "nlpriv:secret" },
};

const inputs = (over: Partial<SetupInputs> = {}): SetupInputs => ({
  installed: true,
  status: STATUS,
  prefs: PREFS,
  serveConfig: SERVE,
  serviceName: "ppm",
  enabled: true,
  ppmPort: 3210,
  platform: "linux",
  osUser: "dev",
  isRoot: false,
  ...over,
});

describe("buildSetupState", () => {
  test("a tagged host serving PPM at an approved service is all set", () => {
    const state = buildSetupState(inputs());
    expect(state).toMatchObject({
      installed: true,
      backendState: "Running",
      canManage: true,
      tailnet: "user@example.com",
      dnsSuffix: "tail1234.ts.net",
      magicDns: true,
      httpsCertificates: true,
      device: { name: "devbox", dnsName: "devbox.tail1234.ts.net", tags: ["tag:server"] },
    });
    expect(state.service).toEqual({
      name: "ppm",
      url: "https://ppm.tail1234.ts.net/",
      defined: true,
      approved: true,
      advertised: true,
      target: "http://127.0.0.1:3210",
      pointsAtPpm: true,
    });
  });

  test("a service advertised but missing from service-host is waiting for an admin", () => {
    const capMap = { ...STATUS.Self.CapMap, "service-host": [{}] };
    const state = buildSetupState(inputs({ status: { ...STATUS, Self: { ...STATUS.Self, CapMap: capMap } } }));
    expect(state.service).toMatchObject({ defined: true, approved: false, advertised: true });
  });

  test("a name used for something else is not PPM's", () => {
    const state = buildSetupState(inputs({ serviceName: "code" }));
    expect(state.service).toMatchObject({ name: "code", url: "https://code.tail1234.ts.net/", defined: true, approved: false, target: null, pointsAtPpm: false });
    expect(buildSetupState(inputs({ ppmPort: 8080 })).service.pointsAtPpm).toBe(false);
  });

  test("on Linux only root and the operator may change Tailscale", () => {
    expect(buildSetupState(inputs({ osUser: "someone-else" })).canManage).toBe(false);
    expect(buildSetupState(inputs({ osUser: "someone-else", isRoot: true })).canManage).toBe(true);
    expect(buildSetupState(inputs({ prefs: null })).canManage).toBeNull();
    expect(buildSetupState(inputs({ platform: "darwin", prefs: null })).canManage).toBe(true);
  });

  test("HTTPS certificates count only when the device's own name has one", () => {
    expect(buildSetupState(inputs({ status: { ...STATUS, CertDomains: [] } })).httpsCertificates).toBe(false);
    expect(buildSetupState(inputs({ status: { ...STATUS, CertDomains: null } })).httpsCertificates).toBe(false);
  });

  test("a signed-out host and a missing daemon still answer", () => {
    const signedOut = buildSetupState(inputs({ status: { BackendState: "NeedsLogin" }, prefs: { ControlURL: "", OperatorUser: "dev" }, serveConfig: {} }));
    expect(signedOut).toMatchObject({ backendState: "NeedsLogin", device: null, dnsSuffix: null, httpsCertificates: false });
    expect(signedOut.service).toMatchObject({ url: null, defined: false, approved: false, target: null });

    const noDaemon = buildSetupState(inputs({ status: null, prefs: null, serveConfig: null }));
    expect(noDaemon).toMatchObject({ installed: true, backendState: null, canManage: null, device: null });
  });
});

test("parsePrefs keeps no key material", () => {
  const parsed = parsePrefs(PREFS);
  expect(parsed).toEqual({ operatorUser: "dev", advertiseServices: ["svc:ppm"], hasControlUrl: true });
  expect(JSON.stringify(parsed)).not.toContain("secret");
});

test("isApprovedHost reads the CapMap shape the CLI checks", () => {
  expect(isApprovedHost(STATUS.Self.CapMap, "svc:ppm")).toBe(true);
  expect(isApprovedHost(STATUS.Self.CapMap, "svc:code")).toBe(false);
  expect(isApprovedHost({ "service-host": [{ "svc:ppm": [] }] }, "svc:ppm")).toBe(false);
  expect(isApprovedHost({}, "svc:ppm")).toBe(false);
});

test("serviceTarget finds the 443 root handler of one service", () => {
  expect(serviceTarget(SERVE, "svc:ppm")).toBe("http://127.0.0.1:3210");
  expect(serviceTarget(SERVE, "svc:code")).toBeNull();
  expect(serviceTarget({}, "svc:ppm")).toBeNull();
});

test("targetPort accepts each way serve writes a local target", () => {
  expect(targetPort("http://127.0.0.1:3210")).toBe(3210);
  expect(targetPort("localhost:3210")).toBe(3210);
  expect(targetPort("3210")).toBe(3210);
  expect(targetPort("http://[::1]:3210")).toBe(3210);
  expect(targetPort("http://192.168.1.5:3210")).toBeNull();
  expect(targetPort(null)).toBeNull();
});
