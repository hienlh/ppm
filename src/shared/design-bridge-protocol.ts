/**
 * The postMessage protocol between the design canvas (parent, PPM's origin) and the bridge
 * script injected into the sandboxed design document (child, an opaque origin).
 *
 * Every message is an envelope `{ppm: BRIDGE_CHANNEL, v: BRIDGE_VERSION, nonce, type, ...}`.
 * The nonce is minted fresh by the parent for every iframe load (`?n=` on the URL) and baked
 * into the document server-side; the bridge echoes its own copy on every message it posts.
 * The parent accepts a child message only when its source is the iframe's `contentWindow`
 * *and* its nonce is the current one: if the frame navigates itself to a foreign page, that
 * page is the new `contentWindow` and passes the source check, but it never saw the nonce —
 * unless the parent had told it, which is why parent → frame envelopes never carry one. The
 * frame authenticates a parent message purely by `event.source`, which only `window.parent`
 * itself can satisfy; no page running inside the frame can forge that.
 *
 * Everything the child sends is untrusted — the page's own scripts can post the same shapes.
 * The validators cap every field; later features append their own validators to the two
 * registries below and must never let a child message cause a write on its own.
 */

import { DESIGN_GEN_RE } from "./design-types";
import { PICKER_CHILD_VALIDATORS, PICKER_PARENT_VALIDATORS } from "./design-bridge-messages-picker";
import { TWEAK_CHILD_VALIDATORS, TWEAK_PARENT_VALIDATORS } from "./design-bridge-messages-tweaks";
import { TRANSFORM_CHILD_VALIDATORS, TRANSFORM_PARENT_VALIDATORS } from "./design-bridge-messages-transform";
import { SLIDES_CHILD_VALIDATORS, SLIDES_PARENT_VALIDATORS } from "./design-bridge-messages-slides";
import { CHECK_CHILD_VALIDATORS, CHECK_PARENT_VALIDATORS } from "./design-bridge-messages-check";

export { DESIGN_GEN_RE };

export const BRIDGE_CHANNEL = "design-bridge";
export const BRIDGE_VERSION = 1;
/** Shape of the per-load nonce. Anything else is dropped by the server and the parent. */
export const BRIDGE_NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** Most `issue` messages one document load may post. */
export const MAX_BRIDGE_ISSUES = 20;

export interface BridgeEnvelope {
  ppm: typeof BRIDGE_CHANNEL;
  v: typeof BRIDGE_VERSION;
  nonce: string | null;
  type: string;
}

type Raw = Record<string, unknown>;
type Validator<T> = (raw: Raw) => T | null;

const str = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function cssGens(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const entries = Object.entries(v as Raw);
  if (entries.length > 64) return null;
  const out: Record<string, string> = {};
  for (const [file, gen] of entries) {
    if (file.length > 512 || typeof gen !== "string" || !DESIGN_GEN_RE.test(gen)) return null;
    out[file] = gen;
  }
  return out;
}

export type IssueKind = "error" | "rejection" | "resource" | "csp";
const ISSUE_KINDS: readonly IssueKind[] = ["error", "rejection", "resource", "csp"];

/** Frame → parent. */
export const CORE_CHILD_VALIDATORS = {
  ready: (m: Raw) => {
    const gen = typeof m.gen === "string" && DESIGN_GEN_RE.test(m.gen) ? m.gen : null;
    const file = str(m.file, 1024);
    const gens = cssGens(m.cssGens);
    if (gen === null || file === null || gens === null || typeof m.instrumented !== "boolean") return null;
    return {
      type: "ready" as const, gen, cssGens: gens, file, instrumented: m.instrumented,
      title: str(m.title, 200) ?? "", docHeight: Math.max(0, num(m.docHeight) ?? 0),
    };
  },
  scroll: (m: Raw) => {
    const x = num(m.x), y = num(m.y);
    return x === null || y === null ? null : { type: "scroll" as const, x, y };
  },
  issue: (m: Raw) => {
    const kind = ISSUE_KINDS.find((k) => k === m.kind);
    const message = str(m.message, 500);
    if (!kind || message === null) return null;
    return { type: "issue" as const, kind, message, source: str(m.source, 1024) ?? undefined, line: num(m.line) ?? undefined };
  },
  "navigate-blocked": (m: Raw) => {
    const href = str(m.href, 2048);
    return href === null ? null : { type: "navigate-blocked" as const, href };
  },
  /** Posted by the expired-token page, which stands in for the design when its token is dead. */
  expired: () => ({ type: "expired" as const }),
} satisfies Record<string, Validator<{ type: string }>>;

/** Parent → frame. */
export const CORE_PARENT_VALIDATORS = {
  "restore-scroll": (m: Raw) => {
    const x = num(m.x), y = num(m.y);
    return x === null || y === null ? null : { type: "restore-scroll" as const, x, y };
  },
} satisfies Record<string, Validator<{ type: string }>>;

// Later features spread their validators into these two objects.
export const CHILD_VALIDATORS = {
  ...CORE_CHILD_VALIDATORS,
  ...PICKER_CHILD_VALIDATORS,
  ...TWEAK_CHILD_VALIDATORS,
  ...TRANSFORM_CHILD_VALIDATORS,
  ...SLIDES_CHILD_VALIDATORS,
  ...CHECK_CHILD_VALIDATORS,
};
export const PARENT_VALIDATORS = {
  ...CORE_PARENT_VALIDATORS,
  ...PICKER_PARENT_VALIDATORS,
  ...TWEAK_PARENT_VALIDATORS,
  ...TRANSFORM_PARENT_VALIDATORS,
  ...SLIDES_PARENT_VALIDATORS,
  ...CHECK_PARENT_VALIDATORS,
};

type Validated<R> = { [K in keyof R]: R[K] extends Validator<infer T> ? T : never }[keyof R];
export type ChildMessage = Validated<typeof CHILD_VALIDATORS> & { nonce: string | null };
export type ParentMessage = Validated<typeof PARENT_VALIDATORS>;
export type ChildMessageType = ChildMessage["type"];
export type ParentMessageType = ParentMessage["type"];

function parseEnvelope(data: unknown, registry: Record<string, Validator<{ type: string }>>): { nonce: string | null; body: { type: string } } | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const m = data as Raw;
  if (m.ppm !== BRIDGE_CHANNEL || m.v !== BRIDGE_VERSION || typeof m.type !== "string") return null;
  if (m.nonce !== null && (typeof m.nonce !== "string" || !BRIDGE_NONCE_RE.test(m.nonce))) return null;
  // Own properties only: a type of "constructor" or "__proto__" must not reach a prototype.
  if (!Object.prototype.hasOwnProperty.call(registry, m.type)) return null;
  const body = registry[m.type]!(m);
  return body ? { nonce: m.nonce as string | null, body } : null;
}

/** A validated child message (nonce included, for the caller to compare), or null. */
export function parseChildMessage(data: unknown): ChildMessage | null {
  const parsed = parseEnvelope(data, CHILD_VALIDATORS);
  return parsed ? ({ ...parsed.body, nonce: parsed.nonce } as ChildMessage) : null;
}

/** A validated parent message, or null. The parent runs this before sending too. */
export function parseParentMessage(data: unknown): ParentMessage | null {
  const parsed = parseEnvelope(data, PARENT_VALIDATORS);
  return parsed ? (parsed.body as ParentMessage) : null;
}

/**
 * The envelope for a parent → frame message; envelope fields win over the payload's.
 *
 * No nonce: the frame never needs one to trust its parent (see the module docstring), and
 * sending one would hand it to any page the frame navigated itself to, for that page to echo
 * straight back and forge a `ready`.
 */
export function parentEnvelope(message: ParentMessage): BridgeEnvelope & ParentMessage {
  return { ...message, ppm: BRIDGE_CHANNEL, v: BRIDGE_VERSION, nonce: null };
}
