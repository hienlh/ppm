import { expect, test } from "bun:test";
import {
  blockingSetupStep,
  currentSetupStep,
  serviceNameProblem,
  serviceUrl,
  type TailscaleSetupState,
} from "../../../src/shared/tailscale-setup.ts";

test("a service name is one lowercase DNS label", () => {
  expect(serviceNameProblem("ppm")).toBeNull();
  expect(serviceNameProblem("ppm-mac2")).toBeNull();
  expect(serviceNameProblem("")).toBe("Enter a name.");
  expect(serviceNameProblem("PPM")).not.toBeNull();
  expect(serviceNameProblem("-ppm")).not.toBeNull();
  expect(serviceNameProblem("ppm-")).not.toBeNull();
  expect(serviceNameProblem("ppm.dev")).not.toBeNull();
  expect(serviceNameProblem("a".repeat(64))).toBe("Use at most 63 characters.");
});

test("serviceUrl needs the tailnet's DNS suffix", () => {
  expect(serviceUrl("ppm", "tail1234.ts.net")).toBe("https://ppm.tail1234.ts.net/");
  expect(serviceUrl("ppm", null)).toBeNull();
});

const ready: TailscaleSetupState = {
  installed: true, backendState: "Running", canManage: true, osUser: "dev", platform: "linux",
  tailnet: "user@example.com", dnsSuffix: "tail1234.ts.net", magicDns: true, httpsCertificates: true,
  device: { name: "devbox", dnsName: "devbox.tail1234.ts.net", ips: ["100.64.0.7"], tags: ["tag:server"] },
  service: { name: "ppm", url: "https://ppm.tail1234.ts.net/", defined: true, approved: false, advertised: false, target: null, pointsAtPpm: false },
  enabled: false, ppmPort: 8080,
};

test("the steps are walked in order, and only the service does not block the switch", () => {
  const at = (patch: Partial<TailscaleSetupState>) => currentSetupStep({ ...ready, ...patch });
  expect(at({ installed: false, backendState: null, canManage: null })).toBe("install");
  expect(at({ backendState: null, canManage: null })).toBe("start");
  // Signing in is itself a change tailscaled refuses from a user it does not trust.
  expect(at({ backendState: "NeedsLogin", canManage: false })).toBe("operator");
  expect(at({ backendState: "NeedsLogin" })).toBe("sign-in");
  expect(at({ backendState: "NeedsMachineAuth" })).toBe("sign-in");
  expect(at({ httpsCertificates: false })).toBe("dns");
  expect(at({ device: { ...ready.device!, tags: [] } })).toBe("tag");
  expect(at({ service: { ...ready.service, defined: false } })).toBe("service");
  expect(at({})).toBeNull();

  expect(blockingSetupStep({ ...ready, service: { ...ready.service, defined: false } })).toBeNull();
  expect(blockingSetupStep({ ...ready, magicDns: false })).toBe("dns");
});
