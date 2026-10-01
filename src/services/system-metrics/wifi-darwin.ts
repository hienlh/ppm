/**
 * The Wi-Fi radio's live facts on macOS — signal, channel, transmit rate — read
 * from CoreWLAN over `bun:ffi` and the Objective-C runtime.
 *
 * Not `system_profiler SPAirPortDataType`, which is where these figures are
 * usually taken from on the command line: it SCANS for nearby networks on every
 * run (3.8 s wall, measured) and the scan is not free for the link either — the
 * gateway's ping maximum went from 73 to 135 ms while it ran. CoreWLAN answers the
 * same questions from the association the radio already has, in 5–10 ms (39 ms at
 * most, measured while a scan was running).
 *
 * That is still a synchronous call on PPM's one event loop, so it is taken at most
 * once per `WIFI_MEMO_MS`. Three things keep it from taking the process down:
 * - every object id is a `u64` (BigInt). Short `NSString`s are TAGGED POINTERS —
 *   the value is the string, with the top bit set — and a JS number cannot hold
 *   that bit, so passing one as a number hands the runtime a different pointer
 *   (measured: a segfault at 0x10, then a C++ exception out of `UTF8String`);
 * - every message is preceded by `class_respondsToSelector`, because an
 *   Objective-C exception unwinding through an FFI frame aborts the process;
 * - each read runs inside its own autorelease pool, or every `ssid` and
 *   `wlanChannel` returned would leak for the life of the server.
 *
 * The network's name is usually absent: since macOS 14 CoreWLAN withholds the
 * SSID from any process without Location Services permission. That is reported
 * as unknown, not guessed from somewhere else.
 */
import { CString, dlopen, FFIType as T, type Pointer } from "bun:ffi";

/** Signal and rate move slowly; a read is a blocking call. */
export const WIFI_MEMO_MS = 5000;

const OBJC = "/usr/lib/libobjc.A.dylib";
const LIBSYSTEM = "/usr/lib/libSystem.B.dylib";
const COREWLAN = "/System/Library/Frameworks/CoreWLAN.framework/CoreWLAN";
const RTLD_LAZY = 1;

/** `CWChannelBand`. */
const BAND_2GHZ = 1;
const BAND_5GHZ = 2;
const BAND_6GHZ = 3;

export interface DarwinWifiStatus {
  /** "en0" — which interface these facts belong to. */
  interfaceName: string;
  /** dBm; 0 when the radio is not associated. */
  rssiDbm?: number;
  noiseDbm?: number;
  /** The rate the radio is transmitting at, Mbit/s; 0 when not associated. */
  transmitRateMbps?: number;
  channel?: number;
  /** `CWChannelBand`: 1 = 2.4 GHz, 2 = 5 GHz, 3 = 6 GHz. */
  band?: number;
  ssid?: string;
}

/** NetworkManager's `nm_wifi_utils_level_to_quality`, which is where the signal
 *  percentage Mission Center shows comes from: -40 dBm and stronger is 100%,
 *  -100 dBm and weaker is 0%, truncated as NM truncates. */
export function signalPercent(rssiDbm: number): number {
  const distance = Math.abs(Math.min(-40, Math.max(-100, rssiDbm)) + 40);
  return Math.max(0, Math.min(100, 100 - Math.trunc((100 * distance) / 60)));
}

/** Centre frequency of a channel, MHz (IEEE 802.11 channel numbering). */
export function channelFrequencyMHz(channel: number, band: number): number | undefined {
  if (!Number.isInteger(channel) || channel <= 0) return undefined;
  if (band === BAND_2GHZ) return channel === 14 ? 2484 : channel <= 13 ? 2407 + 5 * channel : undefined;
  if (band === BAND_5GHZ) return 5000 + 5 * channel;
  // Channel 2 is the one 6 GHz channel off the 5 MHz grid.
  if (band === BAND_6GHZ) return channel === 2 ? 5935 : 5950 + 5 * channel;
  return undefined;
}

/** The facts a NIC row carries. A radio that is off or not associated reports
 *  zeroes, which are left out rather than shown as 0% and 0 Mbps. */
export function wirelessFacts(status: DarwinWifiStatus): {
  ssid?: string; signalPercent?: number; frequencyMHz?: number; linkMbps?: number;
} {
  const frequency = status.channel !== undefined && status.band !== undefined
    ? channelFrequencyMHz(status.channel, status.band)
    : undefined;
  const rate = status.transmitRateMbps;
  return {
    ...(status.ssid ? { ssid: status.ssid } : {}),
    ...(status.rssiDbm !== undefined && status.rssiDbm < 0 ? { signalPercent: signalPercent(status.rssiDbm) } : {}),
    ...(frequency !== undefined ? { frequencyMHz: frequency } : {}),
    ...(rate !== undefined && rate > 0 ? { linkMbps: Math.round(rate) } : {}),
  };
}

type Id = bigint;

interface ObjcRuntime {
  getClass(name: string): Id;
  /** `[obj sel]`, or undefined when obj is nil or does not answer sel. */
  object(obj: Id, sel: string): Id | undefined;
  integer(obj: Id, sel: string): number | undefined;
  double(obj: Id, sel: string): number | undefined;
  utf8(obj: Id): string | undefined;
  pool<R>(body: () => R): R;
}

function openObjcRuntime(): ObjcRuntime | null {
  const base = dlopen(OBJC, {
    objc_getClass: { args: [T.ptr], returns: T.u64 },
    sel_registerName: { args: [T.ptr], returns: T.ptr },
    object_getClass: { args: [T.u64], returns: T.u64 },
    class_respondsToSelector: { args: [T.u64, T.ptr], returns: T.bool },
    objc_autoreleasePoolPush: { args: [], returns: T.ptr },
    objc_autoreleasePoolPop: { args: [T.ptr], returns: T.void },
  }).symbols;
  // One handle per return type: `objc_msgSend` is a trampoline, and the declared
  // signature is what decides which register the answer is read from.
  const sendId = dlopen(OBJC, { objc_msgSend: { args: [T.u64, T.ptr], returns: T.u64 } }).symbols.objc_msgSend;
  const sendPtr = dlopen(OBJC, { objc_msgSend: { args: [T.u64, T.ptr], returns: T.ptr } }).symbols.objc_msgSend;
  const sendI64 = dlopen(OBJC, { objc_msgSend: { args: [T.u64, T.ptr], returns: T.i64 } }).symbols.objc_msgSend;
  const sendF64 = dlopen(OBJC, { objc_msgSend: { args: [T.u64, T.ptr], returns: T.f64 } }).symbols.objc_msgSend;

  const selectors = new Map<string, Pointer>();
  const sel = (name: string) => {
    let s = selectors.get(name);
    if (!s) {
      s = base.sel_registerName(Buffer.from(`${name}\0`)) as Pointer;
      selectors.set(name, s);
    }
    return s;
  };
  const answers = (obj: Id, name: string) =>
    obj !== 0n && base.class_respondsToSelector(base.object_getClass(obj), sel(name));

  return {
    getClass: (name) => base.objc_getClass(Buffer.from(`${name}\0`)) as Id,
    object: (obj, name) => {
      if (!answers(obj, name)) return undefined;
      const r = sendId(obj, sel(name)) as Id;
      return r === 0n ? undefined : r;
    },
    integer: (obj, name) => (answers(obj, name) ? Number(sendI64(obj, sel(name))) : undefined),
    double: (obj, name) => (answers(obj, name) ? (sendF64(obj, sel(name)) as number) : undefined),
    utf8: (obj) => {
      if (!answers(obj, "UTF8String")) return undefined;
      const p = sendPtr(obj, sel("UTF8String")) as Pointer | null;
      return p ? new CString(p).toString() : undefined;
    },
    pool: (body) => {
      const token = base.objc_autoreleasePoolPush();
      try {
        return body();
      } finally {
        base.objc_autoreleasePoolPop(token);
      }
    },
  };
}

/**
 * A reader for the default Wi-Fi interface, or undefined on every call where the
 * runtime or the framework cannot be loaded (never on a real Mac) or there is no
 * Wi-Fi hardware.
 */
export function createCoreWlanReader(): () => DarwinWifiStatus | undefined {
  let runtime: ObjcRuntime | null | undefined;
  return () => {
    if (runtime === undefined) {
      try {
        const loader = dlopen(LIBSYSTEM, { dlopen: { args: [T.ptr, T.i32], returns: T.ptr } }).symbols;
        runtime = loader.dlopen(Buffer.from(`${COREWLAN}\0`), RTLD_LAZY) ? openObjcRuntime() : null;
      } catch {
        runtime = null;
      }
    }
    const rt = runtime;
    if (!rt) return undefined;
    try {
      return rt.pool(() => {
        const cls = rt.getClass("CWWiFiClient");
        const client = cls === 0n ? undefined : rt.object(cls, "sharedWiFiClient");
        const iface = client === undefined ? undefined : rt.object(client, "interface");
        if (iface === undefined) return undefined;
        const name = rt.object(iface, "interfaceName");
        const interfaceName = name === undefined ? undefined : rt.utf8(name);
        if (!interfaceName) return undefined;
        const channel = rt.object(iface, "wlanChannel");
        const ssid = rt.object(iface, "ssid");
        const status: DarwinWifiStatus = { interfaceName };
        const set = <K extends keyof DarwinWifiStatus>(key: K, value: DarwinWifiStatus[K] | undefined) => {
          if (value !== undefined) status[key] = value;
        };
        set("rssiDbm", rt.integer(iface, "rssiValue"));
        set("noiseDbm", rt.integer(iface, "noiseMeasurement"));
        set("transmitRateMbps", rt.double(iface, "transmitRate"));
        if (channel !== undefined) {
          set("channel", rt.integer(channel, "channelNumber"));
          set("band", rt.integer(channel, "channelBand"));
        }
        set("ssid", ssid === undefined ? undefined : rt.utf8(ssid));
        return status;
      });
    } catch {
      return undefined;
    }
  };
}

/** `read` at most once per `ttlMs`, a failure included. */
export function memoWifiStatus(
  read: () => DarwinWifiStatus | undefined,
  now: () => number = Date.now,
  ttlMs = WIFI_MEMO_MS,
): () => DarwinWifiStatus | undefined {
  let last: { at: number; value: DarwinWifiStatus | undefined } | null = null;
  return () => {
    const at = now();
    if (!last || at - last.at >= ttlMs) last = { at, value: read() };
    return last.value;
  };
}

let shared: (() => DarwinWifiStatus | undefined) | null = null;

export function darwinWifiStatus(): DarwinWifiStatus | undefined {
  shared ??= memoWifiStatus(createCoreWlanReader());
  return shared();
}
