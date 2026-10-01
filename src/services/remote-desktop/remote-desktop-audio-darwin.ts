/**
 * macOS host audio: which capture device, if any, carries what the host is *playing*.
 *
 * avfoundation captures real inputs only — a stock Mac has no system-audio device, which is why
 * every Mac used to be reported as having no audio at all. That is wrong for any host with a
 * loopback driver installed, and they are common: BlackHole, Rogue Amoeba's Loopback,
 * Soundflower, Background Music. Measured on this dev host, `ffmpeg -f avfoundation
 * -list_devices true` listed three loopback inputs while PPM reported "macOS has no
 * system-audio input".
 *
 * The device is addressed by **name** (`-i ":BlackHole 2ch"`), never by index, for the same
 * reason the screen is (see the avfoundation note in CLAUDE.md): the list reorders at runtime
 * when a Continuity Camera joins. Verified here — `-i ":Background Music"` produced the same
 * stream `-i ":0"` did.
 *
 * Presence is **not** enough, and that is where macOS differs from Linux rather than merely
 * lagging it. PulseAudio's `@DEFAULT_MONITOR@` *is* the sink by construction, so on Linux a
 * driver that exists is a driver that carries sound. A macOS loopback carries sound only while
 * the host's output actually goes through it, and one that is installed but not selected records
 * perfect silence — which (per the Ogg note in CLAUDE.md) still produces packets, so "packets
 * are flowing" cannot reveal it. Measured on this dev host: the Background Music *driver* was
 * installed while its app had been removed, so the orphaned device was picked, reported as
 * working audio, and delivered 1.5 KB/s of silence — identical byte rates with the host quiet
 * and with a sound playing.
 *
 * So routing is checked, but only in the direction that can be known for certain. If macOS is
 * playing through a device PPM can see is **physical** — the built-in speakers, a USB or
 * Bluetooth headset — then nothing reaches the loopback, full stop, and audio is refused with
 * that device named. Every other answer is accepted, because the Multi-Output Device that is the
 * normal way to both *hear* and capture is named after neither the speakers nor the loopback, so
 * a name match is not the test; an unrecognised transport is treated as "cannot tell" for the
 * same reason. The asymmetry is deliberate: a false "unavailable" takes a working feature away,
 * while the false "available" this replaces hands the viewer silence and calls it audio.
 */

/** One row of `ffmpeg -f avfoundation -list_devices true`'s audio section. */
export interface AvfAudioDevice {
  index: number;
  name: string;
}

/**
 * Loopback drivers whose purpose is to carry the system's own output, best first. Matched
 * case-insensitively against the **start** of the device name, because each ships several
 * channel counts ("BlackHole 2ch", "BlackHole 16ch", "Soundflower (2ch)").
 *
 * This deliberately excludes the loopback devices other *applications* install for their own
 * screen sharing — "Microsoft Teams Audio", "Messenger Loopback Audio" and "NoMachine Audio
 * Adapter" were all present on this dev host. Those carry that application's audio or nothing,
 * so picking one hands the viewer a silent stream while reporting audio as working.
 *
 * A prefix is what keeps that exclusion real, and a substring does not: matching "loopback
 * audio" anywhere in the name picked **"Messenger Loopback Audio"** on this host, over the
 * general-purpose devices, on the first run of the finished code. Rogue Amoeba's own device is
 * named "Loopback Audio" exactly, so nothing is lost by anchoring.
 */
const LOOPBACK_NAMES = [
  "blackhole",
  "loopback audio",
  "soundflower",
  "background music",
  "ishowu audio",
  "vb-cable",
] as const;

/** The install hint, used when the host has no loopback driver at all. */
export const LOOPBACK_INSTALL_HINT =
  "macOS has no system-audio input of its own — install a loopback driver "
  + "(BlackHole, Loopback, Soundflower or Background Music) and route the host's output through it.";

/**
 * Pull the audio devices out of `ffmpeg -f avfoundation -list_devices true` output. The two
 * sections are told apart by their headers, never by index ranges — video and audio both number
 * from 0, so a parser that ignored the headers would offer "FaceTime HD Camera" as an audio
 * device.
 */
export function parseAvfoundationAudioDevices(output: string): AvfAudioDevice[] {
  const devices: AvfAudioDevice[] = [];
  let inAudio = false;
  for (const line of output.split("\n")) {
    if (line.includes("AVFoundation video devices:")) { inAudio = false; continue; }
    if (line.includes("AVFoundation audio devices:")) { inAudio = true; continue; }
    if (!inAudio) continue;
    // Each row is `[AVFoundation indev @ 0x14f..] [0] Background Music`. The leading bracket is
    // not digits, so the first `[<digits>]` on the line is the device index.
    const m = /\[(\d+)\]\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    devices.push({ index: Number(m[1]), name: m[2]! });
  }
  return devices;
}

/** The best system-output loopback among `devices`, or null when the host has none. */
export function pickLoopbackDevice(devices: AvfAudioDevice[]): AvfAudioDevice | null {
  for (const needle of LOOPBACK_NAMES) {
    const hit = devices.find((d) => d.name.toLowerCase().startsWith(needle));
    if (hit) return hit;
  }
  return null;
}

/** Listing costs a real ffmpeg spawn (~1.3 s measured), and the readiness route polls every 2 s
 *  while the checklist is open, so the answer is held. Audio hardware does not come and go often
 *  enough for this to be felt. */
const CACHE_MS = 30_000;
let cache: { at: number; devices: AvfAudioDevice[] } | null = null;

/** Every avfoundation audio input on this host. Never throws — audio is an extra. */
export async function listAvfoundationAudioDevices(ffmpeg: string): Promise<AvfAudioDevice[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.devices;
  let devices: AvfAudioDevice[] = [];
  try {
    const proc = Bun.spawn(
      [ffmpeg, "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
      { stdout: "ignore", stderr: "pipe", stdin: "ignore" },
    );
    // The listing is written to stderr and the run always ends non-zero ("Error opening input"),
    // because `-list_devices` has no input to open. The exit code says nothing here.
    const text = await new Response(proc.stderr).text();
    await proc.exited;
    devices = parseAvfoundationAudioDevices(text);
  } catch { /* no ffmpeg, or it would not start — the caller reports that separately */ }
  cache = { at: Date.now(), devices };
  return devices;
}

/** The loopback device this host should capture, or null when it has none. */
export async function darwinLoopbackDevice(ffmpeg: string): Promise<AvfAudioDevice | null> {
  return pickLoopbackDevice(await listAvfoundationAudioDevices(ffmpeg));
}

/** Test seam: the cached listing is process-wide and would leak between cases. */
export function clearAvfoundationDeviceCache(): void {
  cache = null;
}

/** The device macOS is currently playing through, as `system_profiler` describes it. */
export interface DefaultAudioOutput {
  name: string;
  /** `coreaudio_device_transport`, e.g. `coreaudio_device_type_builtin`. */
  transport: string | null;
}

/**
 * Transports that can only be a real piece of hardware. A loopback driver is invisible to all of
 * them, so when the host plays through one, the capture is certainly silent.
 *
 * Only `builtin` is verified here — it is what this dev host answered — and the rest are the
 * obvious siblings. That inexactness is safe in one direction only, which is why the set lists
 * what to **refuse** rather than what to accept: a transport missing from it falls through to
 * "cannot tell", i.e. to the permissive answer this check replaces. An aggregate or Multi-Output
 * Device must land there, and does, since neither is named here.
 */
const PHYSICAL_TRANSPORTS: ReadonlySet<string> = new Set([
  "coreaudio_device_type_builtin",
  "coreaudio_device_type_usb",
  "coreaudio_device_type_bluetooth",
  "coreaudio_device_type_bluetoothle",
  "coreaudio_device_type_hdmi",
  "coreaudio_device_type_displayport",
  "coreaudio_device_type_firewire",
  "coreaudio_device_type_thunderbolt",
  "coreaudio_device_type_airplay",
]);

/**
 * Find the default output device anywhere in `system_profiler SPAudioDataType -json`.
 *
 * The walk is recursive and keys off the flag rather than off the document's shape: the devices
 * sit under `SPAudioDataType[0]._items` on this host, but that nesting is an implementation
 * detail of the report and a Mac with several audio buses groups them differently. One flagged
 * object is all this needs, and `_name` is on it.
 */
export function parseDefaultAudioOutput(report: unknown): DefaultAudioOutput | null {
  let found: DefaultAudioOutput | null = null;
  const walk = (node: unknown): void => {
    if (found || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const child of node) walk(child); return; }
    const row = node as Record<string, unknown>;
    if (row.coreaudio_default_audio_output_device === "spaudio_yes" && typeof row._name === "string") {
      const transport = row.coreaudio_device_transport;
      found = { name: row._name, transport: typeof transport === "string" ? transport : null };
      return;
    }
    for (const child of Object.values(row)) walk(child);
  };
  walk(report);
  return found;
}

/**
 * Why `loopback` cannot carry the host's audio, or null when it can — or when that is not
 * knowable, which counts as "can" (see the header).
 */
export function routingRefusal(
  loopback: string,
  output: DefaultAudioOutput | null,
): string | null {
  if (!output) return null;
  if (output.name.toLowerCase() === loopback.toLowerCase()) return null;
  if (!output.transport || !PHYSICAL_TRANSPORTS.has(output.transport)) return null;
  return `"${loopback}" is installed, but the host plays through ${output.name}, so it captures `
    + "silence. Select the loopback as the host's output device — or, to keep hearing the host "
    + "too, a Multi-Output Device combining the two.";
}

/** `system_profiler` costs a spawn (0.22 s measured), and the readiness route polls while the
 *  checklist is open. Held for the same reason the device listing is, and separately, because a
 *  user fixing their routing should not also wait out the ffmpeg listing's cache. */
let routingCache: { at: number; output: DefaultAudioOutput | null } | null = null;

/** The device macOS currently plays through. Never throws — audio is an extra. */
export async function defaultAudioOutput(): Promise<DefaultAudioOutput | null> {
  if (routingCache && Date.now() - routingCache.at < CACHE_MS) return routingCache.output;
  let output: DefaultAudioOutput | null = null;
  try {
    const proc = Bun.spawn(["system_profiler", "SPAudioDataType", "-json"], {
      stdout: "pipe", stderr: "ignore", stdin: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    output = parseDefaultAudioOutput(JSON.parse(text));
  } catch { /* no system_profiler, or unparseable — fall through to "cannot tell" */ }
  routingCache = { at: Date.now(), output };
  return output;
}

/** Test seam, as `clearAvfoundationDeviceCache` is. */
export function clearAudioRoutingCache(): void {
  routingCache = null;
}
