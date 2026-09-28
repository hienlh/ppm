import { parseSlideDoc } from "./design-slide-doc-parse";

/**
 * Bridge messages for the PowerPoint export, spread into the protocol's registries.
 *
 * Parent → frame: `slides-extract`, asking the bridge to measure every slide of the live
 * canvas. Frame → parent: `slides-data` (the measured deck) or `slides-error` (why it could
 * not). Both echo the parent's `requestId`, so an answer to an earlier request (or one a page
 * script invents) is not taken for the current one. The deck is validated whole by
 * {@link parseSlideDoc}; it only ever becomes a file the user downloads, never a write.
 */

/** Shape of a request id: the parent mints it, the frame echoes it. */
export const SLIDES_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

type Raw = Record<string, unknown>;
const requestId = (v: unknown): string | null => (typeof v === "string" && SLIDES_REQUEST_ID_RE.test(v) ? v : null);

export const SLIDES_CHILD_VALIDATORS = {
  "slides-data": (m: Raw) => {
    const id = requestId(m.requestId);
    const doc = id ? parseSlideDoc(m.doc) : null;
    return id && doc ? { type: "slides-data" as const, requestId: id, doc } : null;
  },
  "slides-error": (m: Raw) => {
    const id = requestId(m.requestId);
    if (!id || typeof m.message !== "string") return null;
    return { type: "slides-error" as const, requestId: id, message: m.message.slice(0, 300) };
  },
};

export const SLIDES_PARENT_VALIDATORS = {
  "slides-extract": (m: Raw) => {
    const id = requestId(m.requestId);
    return id ? { type: "slides-extract" as const, requestId: id } : null;
  },
};
