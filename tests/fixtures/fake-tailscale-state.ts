/**
 * The state file `fake-tailscale.ts` answers from, and the log of what it was asked. Kept
 * apart from the fake itself because that module runs as a CLI the moment it is imported.
 */
import { existsSync, readFileSync } from "node:fs";

export interface FakeTailscaleState {
  backendState: string;
  tailnet: string;
  suffix: string;
  magicDns: boolean;
  https: boolean;
  hostName: string;
  tags: string[];
  operatorUser: string;
  /** Set once the node has been signed in before; enables `tailscale up`'s revert check. */
  controlUrl: string;
  /** Flags `tailscale up` insists on seeing repeated, e.g. `--operator=dev`. */
  nonDefaultFlags: string[];
  /** tailscaled refuses changes from this user (not root, not the operator). */
  accessDenied: boolean;
  authUrl: string;
  definedServices: string[];
  approvedServices: string[];
  advertiseServices: string[];
  /** `serve status --json`'s Services section. */
  services: Record<string, unknown>;
  /** `serve status --json`'s Foreground section: one entry per `tailscale serve` still running, keyed by its PID. */
  foreground: Record<string, unknown>;
}

export const DEFAULT_FAKE_STATE: FakeTailscaleState = {
  backendState: "Running",
  tailnet: "user@example.com",
  suffix: "tail1234.ts.net",
  magicDns: true,
  https: true,
  hostName: "devbox",
  tags: ["tag:server"],
  operatorUser: "dev",
  controlUrl: "https://controlplane.tailscale.com",
  nonDefaultFlags: ["--operator=dev"],
  accessDenied: false,
  authUrl: "https://login.tailscale.com/a/fake0123456789",
  definedServices: ["ppm"],
  approvedServices: [],
  advertiseServices: [],
  services: {},
  foreground: {},
};

/**
 * Every argv the fake ran with, one JSON line each. An append log rather than a field of
 * the state file: PPM reads status, prefs and serve config in parallel, and three
 * processes rewriting one file lose each other's entries (or interleave half a file).
 */
export const fakeCallsFile = (stateFile: string) => `${stateFile}.calls`;

export function readFakeCalls(stateFile: string): string[][] {
  const log = fakeCallsFile(stateFile);
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
}
