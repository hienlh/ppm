/**
 * CoreFoundation over bun:ffi, for the frameworks that answer in CF objects —
 * IOReport and the HID event system. Only what those two readers need is bound.
 *
 * Every CF reference is a `bigint` (declared `u64`), never bun's `ptr`. A `ptr`
 * crosses into JS as a number, i.e. a double, and CoreFoundation hands out TAGGED
 * pointers for small immutable objects: on arm64 a short ASCII CFString is a value
 * with the top bit set, far above 2^53, which a double silently rounds. The next
 * call then receives a different "pointer". Measured: `CFStringCreateWithCString`
 * gave "Energy Model" a heap address that crossed intact and "CPU Stats" a tagged
 * value that did not, and releasing the rounded one crashed the process with a
 * segfault at 0x10. A u64 crosses exactly, so a tagged reference survives the trip.
 */
import { dlopen, FFIType as T } from "bun:ffi";

const CORE_FOUNDATION = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
/** kCFStringEncodingUTF8. */
const UTF8 = 0x08000100;
/** Longest string `text` reads back: a channel, state or sensor name is a few dozen bytes. */
const TEXT_BUFFER_BYTES = 1024;

/** A CF object reference; `0n` is NULL. */
export type CfRef = bigint;

export interface CoreFoundation {
  /** A new CFString that the caller owns: release it, or keep it for the process. */
  string(value: string): CfRef;
  /** A CFString's text. Undefined for NULL, for an object that is not a string,
   *  and for text too long to read back whole. */
  text(ref: CfRef): string | undefined;
  /** No-op for NULL: `CFRelease(NULL)` is a crash, not an error. */
  release(ref: CfRef): void;
  dictGet(dict: CfRef, key: CfRef): CfRef;
  dictMutableCopy(dict: CfRef): CfRef;
  dictSet(dict: CfRef, key: CfRef, value: CfRef): void;
  arrayCount(array: CfRef): number;
  arrayAt(array: CfRef, index: number): CfRef;
  arrayMutableCopy(array: CfRef): CfRef;
  arrayRemoveAt(array: CfRef, index: number): void;
}

const R = T.u64;

function open(): CoreFoundation | null {
  if (process.platform !== "darwin") return null;
  let cf;
  try {
    cf = dlopen(CORE_FOUNDATION, {
      CFStringCreateWithCString: { args: [R, T.ptr, T.u32], returns: R },
      CFStringGetCString: { args: [R, T.ptr, T.i64, T.u32], returns: T.bool },
      CFStringGetTypeID: { args: [], returns: T.u64 },
      CFGetTypeID: { args: [R], returns: T.u64 },
      CFRelease: { args: [R], returns: T.void },
      CFDictionaryGetValue: { args: [R, R], returns: R },
      CFDictionaryCreateMutableCopy: { args: [R, T.i64, R], returns: R },
      CFDictionarySetValue: { args: [R, R, R], returns: T.void },
      CFArrayGetCount: { args: [R], returns: T.i64 },
      CFArrayGetValueAtIndex: { args: [R, T.i64], returns: R },
      CFArrayCreateMutableCopy: { args: [R, T.i64, R], returns: R },
      CFArrayRemoveValueAtIndex: { args: [R, T.i64], returns: T.void },
    }).symbols;
  } catch {
    return null;
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(TEXT_BUFFER_BYTES);
  const stringType = cf.CFStringGetTypeID() as bigint;
  const ref = (value: unknown): CfRef => (typeof value === "bigint" ? value : BigInt(value as number));

  return {
    string: (value) => ref(cf.CFStringCreateWithCString(0n, encoder.encode(`${value}\0`), UTF8)),
    text(r) {
      if (r === 0n || ref(cf.CFGetTypeID(r)) !== stringType) return undefined;
      if (!cf.CFStringGetCString(r, buffer, buffer.length, UTF8)) return undefined;
      const end = buffer.indexOf(0);
      return decoder.decode(buffer.subarray(0, end < 0 ? buffer.length : end));
    },
    release(r) {
      if (r !== 0n) cf.CFRelease(r);
    },
    dictGet: (dict, key) => ref(cf.CFDictionaryGetValue(dict, key)),
    dictMutableCopy: (dict) => ref(cf.CFDictionaryCreateMutableCopy(0n, 0, dict)),
    dictSet: (dict, key, value) => cf.CFDictionarySetValue(dict, key, value),
    arrayCount: (array) => Number(cf.CFArrayGetCount(array)),
    arrayAt: (array, index) => ref(cf.CFArrayGetValueAtIndex(array, index)),
    arrayMutableCopy: (array) => ref(cf.CFArrayCreateMutableCopy(0n, 0, array)),
    arrayRemoveAt: (array, index) => cf.CFArrayRemoveValueAtIndex(array, index),
  };
}

/** `undefined` until first asked for; `null` off darwin or where the framework will not load. */
let shared: CoreFoundation | null | undefined;

export function darwinCoreFoundation(): CoreFoundation | null {
  if (shared === undefined) shared = open();
  return shared;
}
