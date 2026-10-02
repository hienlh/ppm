/**
 * The EmulatorController gRPC channel.
 *
 * Two rules this file exists to enforce, both of them measured in Phase 0:
 *
 *  - **Never `protoLoader.loadSync()`.** It reads the .proto off disk at call time, and in a
 *    compiled PPM that path resolves under `file:///$bunfs/root/` and throws ENOENT. The
 *    descriptor is generated at build time (`scripts/gen-android-proto.ts`) and imported, so the
 *    bundler embeds it. Same trap family as `bundledServerEntry` in CLAUDE.md.
 *  - **Never dial anything but loopback.** The endpoint comes from the emulator's own discovery
 *    file and nothing else; the browser can neither supply a gRPC URL nor name a host.
 *
 * grpc-js refuses call credentials on an insecure channel ("Cannot create secure credentials
 * with an insecure channel"), so the bearer token travels as per-call metadata instead. That is
 * safe here precisely because the channel never leaves 127.0.0.1.
 */
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { emulatorControllerDescriptor } from "./proto/emulator-controller-descriptor.ts";
import type { RunningEmulator } from "./emulator-discovery.ts";

/** A full-resolution RGB888 frame at 1080x2400 is 7.8 MB; grpc-js caps receives at 4 MB by
 *  default and would fail the stream with RESOURCE_EXHAUSTED without naming the size. */
const MAX_RECEIVE_BYTES = 64 * 1024 * 1024;

const DEFAULT_DEADLINE_MS = 5_000;

let cachedCtor: any = null;

function controllerCtor(): any {
  if (cachedCtor) return cachedCtor;
  const def = protoLoader.fromJSON(
    emulatorControllerDescriptor as unknown as Parameters<typeof protoLoader.fromJSON>[0],
    {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      // Buffer, not base64: the screenshot path must not pay a string round trip per frame.
      bytes: Buffer,
    },
  );
  const pkg = grpc.loadPackageDefinition(def) as any;
  cachedCtor = pkg.android.emulation.control.EmulatorController;
  return cachedCtor;
}

export interface EmulatorChannel {
  readonly client: any;
  readonly metadata: grpc.Metadata;
  readonly target: string;
  close(): void;
}

export function connectToEmulator(emulator: RunningEmulator): EmulatorChannel {
  const target = `127.0.0.1:${emulator.grpcPort}`;
  const client = new (controllerCtor())(target, grpc.credentials.createInsecure(), {
    "grpc.max_receive_message_length": MAX_RECEIVE_BYTES,
    // Keepalive so a wedged emulator surfaces as a broken channel instead of a silent stall.
    "grpc.keepalive_time_ms": 20_000,
    "grpc.keepalive_timeout_ms": 5_000,
    "grpc.keepalive_permit_without_calls": 1,
  });

  const metadata = new grpc.Metadata();
  if (emulator.grpcToken) metadata.set("authorization", `Bearer ${emulator.grpcToken}`);

  return {
    client,
    metadata,
    target,
    close: () => grpc.closeClient(client),
  };
}

/** One unary call with a deadline, promisified. A hung emulator can never wedge a caller. */
export function unaryCall<T = any>(
  channel: EmulatorChannel,
  method: string,
  arg: unknown = {},
  timeoutMs = DEFAULT_DEADLINE_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = new Date(Date.now() + timeoutMs);
    channel.client[method](arg, channel.metadata, { deadline }, (e: Error | null, res: T) => {
      if (e) reject(e); else resolve(res);
    });
  });
}

export interface EmulatorStatus {
  booted: boolean;
  uptimeMs: number;
  displayWidth: number | null;
  displayHeight: number | null;
  displayDensity: number | null;
}

function hardwareEntry(status: any, key: string): string | undefined {
  return (status?.hardwareConfig?.entry ?? []).find((e: any) => e.key === key)?.value;
}

export async function getEmulatorStatus(channel: EmulatorChannel): Promise<EmulatorStatus> {
  const s = await unaryCall(channel, "getStatus");
  const num = (k: string) => {
    const v = Number(hardwareEntry(s, k));
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  return {
    booted: !!s.booted,
    uptimeMs: Number(s.uptime ?? 0),
    displayWidth: num("hw.lcd.width"),
    displayHeight: num("hw.lcd.height"),
    displayDensity: num("hw.lcd.density"),
  };
}

/** Ask the VM to shut down. Graceful: measured, the process is gone in 1-3 seconds, so nothing
 *  here ever needs to signal a pid — and never by process *name*, which on this very host
 *  matches Docker Desktop's qemu. */
export async function requestShutdown(channel: EmulatorChannel, timeoutMs = 10_000): Promise<void> {
  await unaryCall(channel, "setVmState", { state: "SHUTDOWN" }, timeoutMs);
}
