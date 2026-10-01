/** Captures from a real M1 Max (macOS 15), sanitised — see `darwin/`. Read as
 *  text so every darwin test loads them the same way, JSON included. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function darwinFixture(name: string): string {
  return readFileSync(join(import.meta.dir, "darwin", name), "utf-8");
}

/** `vm-capture-m1max.json`: the raw kernel structs next to the tools that print them. */
export interface VmCapture {
  kr: number;
  count: number;
  vmStatistics64Hex: string;
  vmStatBefore: string;
  vmStatAfter: string;
  xswUsageHex: string;
  swapusageText: string;
  vmPagesizeHex: string;
  hwMemsizeHex: string;
  hwMemsizeUsableHex: string;
}

export function vmCapture(): VmCapture {
  return JSON.parse(darwinFixture("vm-capture-m1max.json")) as VmCapture;
}

export const hexBytes = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));

/**
 * A `DarwinKernel` answering from `sysctl name: value` lines — numbers as
 * numbers, anything else as a string — plus raw struct values by name. Every
 * page count and thread total is left undefined unless given.
 */
export function fakeKernel(
  sysctl: string,
  over: {
    bytes?: Record<string, Uint8Array>;
    vm?: DarwinKernelShape["vmStatistics"];
    load?: DarwinKernelShape["processorSetLoad"];
  } = {},
): DarwinKernelShape {
  const values = new Map<string, string>();
  for (const line of sysctl.split("\n")) {
    const sep = line.indexOf(": ");
    if (sep > 0) values.set(line.slice(0, sep).trim(), line.slice(sep + 2).trim());
  }
  return {
    sysctlNumber: (name) => {
      const v = values.get(name);
      return v !== undefined && /^-?\d+$/.test(v) ? Number(v) : undefined;
    },
    sysctlString: (name) => values.get(name),
    sysctlBytes: (name) => over.bytes?.[name],
    vmStatistics: over.vm ?? (() => undefined),
    processorSetLoad: over.load ?? (() => undefined),
  };
}

type DarwinKernelShape = import("../../../../../src/services/system-metrics/darwin-ffi.ts").DarwinKernel;

/** Ten little-endian u64s, the shape of `hw.cacheconfig` / `hw.cachesize`. */
export function u64Array(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 8);
  const v = new DataView(out.buffer);
  values.forEach((n, i) => v.setBigUint64(i * 8, BigInt(n), true));
  return out;
}
