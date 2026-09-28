import { CHECK_REQUEST_ID_RE, parseLayoutCheckReport } from "./design-canvas-check";

/**
 * Bridge messages for the canvas self-check, spread into the protocol's registries.
 *
 * Parent → frame: `check-run`, asking the bridge to measure the live document. `screenshot`
 * asks for an image too, and then `lib` carries the screenshot library's source: the frame
 * can load nothing from PPM's origin but its own design files, so the parent hands the code
 * over and the frame runs it (its CSP allows eval). Frame → parent: `check-result` (the
 * report, validated whole) or `check-error`. Both echo the parent's `requestId`, so an answer
 * to an earlier request — or one a page script invents — is not taken for the current one.
 * A report only ever becomes text an agent reads, never a write.
 */

/** Generous for the library's ~30 KB; anything bigger is not the library. */
export const MAX_CHECK_LIB_CHARS = 256 * 1024;

type Raw = Record<string, unknown>;
const requestId = (v: unknown): string | null => (typeof v === "string" && CHECK_REQUEST_ID_RE.test(v) ? v : null);

export const CHECK_CHILD_VALIDATORS = {
  "check-result": (m: Raw) => {
    const id = requestId(m.requestId);
    const report = id ? parseLayoutCheckReport(m.report) : null;
    return id && report ? { type: "check-result" as const, requestId: id, report } : null;
  },
  "check-error": (m: Raw) => {
    const id = requestId(m.requestId);
    if (!id || typeof m.message !== "string") return null;
    return { type: "check-error" as const, requestId: id, message: m.message.slice(0, 300) };
  },
};

export const CHECK_PARENT_VALIDATORS = {
  "check-run": (m: Raw) => {
    const id = requestId(m.requestId);
    if (!id || typeof m.screenshot !== "boolean") return null;
    if (m.lib !== undefined && (typeof m.lib !== "string" || m.lib.length > MAX_CHECK_LIB_CHARS)) return null;
    return {
      type: "check-run" as const, requestId: id, screenshot: m.screenshot,
      ...(typeof m.lib === "string" ? { lib: m.lib } : {}),
    };
  },
};
