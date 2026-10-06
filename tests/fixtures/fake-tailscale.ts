/**
 * A stand-in for the `tailscale` CLI, driven by a JSON state file named by its first
 * argument. It answers the commands PPM's Tailscale settings and Tailscale forwards use with
 * the shapes and messages of the real CLI (1.102.4), so tests never sign a real machine in or
 * touch a real tailnet. A test plays the person and the admin by editing the file:
 * `backendState: "Running"` finishes a waiting sign-in, `approvedServices` approves a host.
 * What it was asked is logged beside the file (`readFakeCalls`).
 *
 *   bun tests/fixtures/fake-tailscale.ts /tmp/state.json status --json
 *
 * The path is an argument rather than an environment variable because `Bun.spawn`
 * passes children the environment the test process *started* with: a variable set in a
 * `beforeEach` never reaches them.
 */
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { DEFAULT_FAKE_STATE, fakeCallsFile, type FakeTailscaleState } from "./fake-tailscale-state.ts";

const ACCIDENTAL_UP_PREFIX = "Error: changing settings via 'tailscale up' requires mentioning all\n"
  + "non-default flags. To proceed, either re-run your command with --reset or\n"
  + "use the command below to explicitly mention the current value of\n"
  + "all non-default settings:\n\n"
  + "\ttailscale up";

const STATE_FILE = process.argv[2];
if (!STATE_FILE?.endsWith(".json")) throw new Error("usage: fake-tailscale.ts <state.json> <tailscale args…>");
const load = (): FakeTailscaleState => ({ ...DEFAULT_FAKE_STATE, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) });
/** Only commands that change something write, each through a temp file of its own. */
const save = (state: FakeTailscaleState) => {
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, STATE_FILE);
};

const dnsName = (s: FakeTailscaleState) => `${s.hostName}.${s.suffix}`;
const vip = (name: string) => `100.100.${name.length}.${name.charCodeAt(0)}`;

function status(s: FakeTailscaleState) {
  if (s.backendState !== "Running") return { BackendState: s.backendState, Self: null, CertDomains: null, MagicDNSSuffix: "" };
  const capMap: Record<string, unknown> = {};
  const hosted: Record<string, string[]> = {};
  for (const name of s.definedServices) capMap[`services/${name}`] = [{ Name: `svc:${name}`, Addrs: [vip(name)], Ports: ["tcp:443"] }];
  for (const name of s.approvedServices) {
    if (s.advertiseServices.includes(`svc:${name}`)) hosted[`svc:${name}`] = [vip(name)];
  }
  if (s.tags.length) capMap["service-host"] = [hosted];
  return {
    BackendState: "Running",
    MagicDNSSuffix: s.suffix,
    CurrentTailnet: { Name: s.tailnet, MagicDNSSuffix: s.suffix, MagicDNSEnabled: s.magicDns },
    CertDomains: s.https ? [dnsName(s), ...s.approvedServices.map((n) => `${n}.${s.suffix}`)] : null,
    Self: { HostName: s.hostName, DNSName: `${dnsName(s)}.`, TailscaleIPs: ["100.64.0.7"], Tags: s.tags.length ? s.tags : undefined, CapMap: capMap },
  };
}

function out(text: string) { process.stdout.write(text); }
function fail(text: string, code = 1): never { process.stderr.write(text.endsWith("\n") ? text : `${text}\n`); process.exit(code); }

async function up(s: FakeTailscaleState, flags: string[]) {
  if (flags.length === 0) {
    // A bare `up` only switches a signed-in node back on.
    if (s.accessDenied) fail("Access denied: prefs write access denied");
    if (s.backendState === "Stopped") save({ ...load(), backendState: "Running" });
    return;
  }
  if (s.accessDenied) fail("Access denied: checkprefs access denied");
  const missing = s.controlUrl ? s.nonDefaultFlags.filter((f) => !flags.includes(f)) : [];
  if (missing.length) fail(`${ACCIDENTAL_UP_PREFIX} ${[...flags, ...missing].join(" ")}\n\n`);
  if (!flags.includes("--json")) fail("this fake only signs in with --json");
  out(`${JSON.stringify({ AuthURL: s.authUrl, QR: "data:image/png;base64,AAAA", BackendState: "NeedsLogin" }, null, "\t")}\n`);
  // Wait for the "person" to finish in the browser: the test flips the state file.
  while (true) {
    await Bun.sleep(40);
    const now = load();
    if (now.backendState === "Running" || now.backendState === "NeedsMachineAuth") {
      out(`${JSON.stringify({ BackendState: now.backendState }, null, "\t")}\n`);
      return;
    }
  }
}

/** A forward's `tailscale serve --https=N TARGET`: serves until stopped, as the real one does without --bg. */
function serveInForeground(port: string, target: string) {
  const session = String(process.pid);
  const host = port === "443" ? dnsName(load()) : `${dnsName(load())}:${port}`;
  const s = load();
  save({ ...s, foreground: { ...s.foreground, [session]: { TCP: { [port]: { HTTPS: true } }, Web: { [host]: { Handlers: { "/": { Proxy: target } } } } } } });
  out(`Available within your tailnet:\n\nhttps://${host}/\n|-- proxy ${target}\n\nPress Ctrl+C to exit.\n`);
  const stop = () => {
    const now = load();
    const { [session]: _gone, ...rest } = now.foreground;
    save({ ...now, foreground: rest });
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  setInterval(() => {}, 60_000);
}

function serve(s: FakeTailscaleState, args: string[]) {
  if (args[0] === "status") {
    const foreground = Object.keys(s.foreground).length ? { Foreground: s.foreground } : {};
    out(`${JSON.stringify({ Services: s.services, ...foreground })}\n`);
    return;
  }
  if (args[0] === "clear") {
    const svc = args[1]!;
    const { [svc]: _gone, ...rest } = s.services;
    save({ ...s, services: rest, advertiseServices: s.advertiseServices.filter((x) => x !== svc) });
    return;
  }
  const svc = args.find((a) => a.startsWith("--service="))?.slice("--service=".length);
  const target = args.filter((a) => !a.startsWith("--")).at(-1);
  const https = args.find((a) => a.startsWith("--https="))?.slice("--https=".length);
  if (!svc && https && target && !args.includes("--bg")) { serveInForeground(https, target); return; }
  if (!svc || !target) fail("this fake only serves --service=svc:NAME --https=443 TARGET");
  if (!s.tags.length) fail("service hosts must be tagged nodes");
  if (s.accessDenied) fail("Access denied: serve config denied");
  const name = svc.slice("svc:".length);
  const host = `${name}.${s.suffix}`;
  const services = { ...s.services, [svc]: { TCP: { "443": { HTTPS: true } }, Web: { [`${host}:443`]: { Handlers: { "/": { Proxy: target } } } } } };
  const advertiseServices = s.advertiseServices.includes(svc) ? s.advertiseServices : [...s.advertiseServices, svc];
  save({ ...s, services, advertiseServices });
  if (s.approvedServices.includes(name)) out(`Available within your tailnet:\n\nhttps://${host}/\n|-- proxy ${target}\n`);
  else out(`This machine is configured as a service proxy for ${svc}, but approval from an admin is required. Once approved, it will be available in your Tailnet as:\n\nhttps://${host}/\n|-- proxy ${target}\n`);
}

const argv = process.argv.slice(3);
appendFileSync(fakeCallsFile(STATE_FILE), `${JSON.stringify(argv)}\n`);
const state = load();
const [cmd, ...rest] = argv;
if (cmd === "version") out("1.102.4\n");
else if (cmd === "status") out(`${JSON.stringify(status(state))}\n`);
else if (cmd === "debug" && rest[0] === "prefs") {
  out(`${JSON.stringify({ ControlURL: state.controlUrl, OperatorUser: state.operatorUser, AdvertiseServices: state.advertiseServices, AdvertiseTags: state.tags, Config: { PrivateNodeKey: "privkey:fake" } })}\n`);
} else if (cmd === "up") await up(state, rest);
else if (cmd === "serve") serve(state, rest);
else fail(`fake tailscale: unsupported command ${argv.join(" ")}`);
