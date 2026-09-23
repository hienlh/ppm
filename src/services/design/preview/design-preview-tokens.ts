/**
 * Capabilities for the design preview route: an unguessable token that lets a sandboxed
 * iframe (which carries no PPM credentials) read one design's files.
 *
 * The rules, and why:
 *  - A token names one design (`projectPath` + `slug`) and one purpose. It never authorises
 *    another design, even in the same project.
 *  - Resolving a token — what every unauthenticated content GET does — never extends it. If
 *    reads slid the expiry, anything that learned a token could keep it alive forever.
 *  - Only the authenticated refresh extends a canvas token, by the idle TTL, and never past a
 *    hard cap counted from mint. Close to that cap the refresh *rotates*: it returns a new
 *    token for the canvas's next reload, while the old one keeps serving the document already
 *    loaded — refreshing the new token extends the old one too — until its own hard cap.
 *  - Print and standalone tokens are short-lived and cannot be refreshed.
 *
 * Pure logic with `now` injected; the store lives in memory, so a restart invalidates every
 * token and the canvas re-mints.
 */

export const DESIGN_PREVIEW_PURPOSES = ["canvas", "print", "standalone"] as const;
export type DesignPreviewPurpose = (typeof DESIGN_PREVIEW_PURPOSES)[number];

export function isDesignPreviewPurpose(value: unknown): value is DesignPreviewPurpose {
  return typeof value === "string" && (DESIGN_PREVIEW_PURPOSES as readonly string[]).includes(value);
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
export const CANVAS_IDLE_TTL = 30 * MINUTE;
export const CANVAS_HARD_TTL = 8 * HOUR;
/** Refreshing inside this window before the hard cap hands out a successor token. */
export const ROTATE_WINDOW = HOUR;
export const ONE_SHOT_TTL = 10 * MINUTE;
export const MAX_PREVIEW_TOKENS = 128;

export interface DesignPreviewCapability {
  token: string;
  projectPath: string;
  slug: string;
  purpose: DesignPreviewPurpose;
  mintedAt: number;
  idleExpires: number;
  hardExpires: number;
  /** Set once this token has been rotated, so repeated refreshes return one successor. */
  successor?: string;
  /** The token this one replaced, which may still be serving the loaded document. */
  predecessor?: string;
}

export interface DesignRef {
  projectPath: string;
  slug: string;
}

export type RefreshResult =
  | { ok: true; capability: DesignPreviewCapability; rotated: boolean }
  | { ok: false; reason: "unknown" | "wrong-design" | "not-refreshable" };

export interface DesignPreviewTokenStore {
  mint(design: DesignRef, purpose: DesignPreviewPurpose): DesignPreviewCapability;
  /** Authenticated only: extends a canvas token, rotating it near the hard cap. */
  refresh(token: string, design: DesignRef): RefreshResult;
  /** The live capability for a token, or null. Never changes any expiry. */
  resolve(token: string): DesignPreviewCapability | null;
  size(): number;
}

export function createDesignPreviewTokenStore(
  now: () => number = Date.now,
  maxTokens = MAX_PREVIEW_TOKENS,
): DesignPreviewTokenStore {
  const tokens = new Map<string, DesignPreviewCapability>();
  const alive = (cap: DesignPreviewCapability, at: number): boolean => at < cap.idleExpires && at < cap.hardExpires;

  function prune(at: number): void {
    for (const [token, cap] of tokens) if (!alive(cap, at)) tokens.delete(token);
  }

  function mint(design: DesignRef, purpose: DesignPreviewPurpose): DesignPreviewCapability {
    const at = now();
    prune(at);
    // Oldest first: Map iteration is insertion order.
    while (tokens.size >= maxTokens) tokens.delete(tokens.keys().next().value!);
    const hard = at + (purpose === "canvas" ? CANVAS_HARD_TTL : ONE_SHOT_TTL);
    const cap: DesignPreviewCapability = {
      token: crypto.randomUUID(),
      projectPath: design.projectPath,
      slug: design.slug,
      purpose,
      mintedAt: at,
      idleExpires: purpose === "canvas" ? Math.min(at + CANVAS_IDLE_TTL, hard) : hard,
      hardExpires: hard,
    };
    tokens.set(cap.token, cap);
    return cap;
  }

  function resolve(token: string): DesignPreviewCapability | null {
    const cap = tokens.get(token);
    if (!cap) return null;
    if (!alive(cap, now())) {
      tokens.delete(token);
      return null;
    }
    return cap;
  }

  function refresh(token: string, design: DesignRef): RefreshResult {
    const cap = resolve(token);
    if (!cap) return { ok: false, reason: "unknown" };
    if (cap.projectPath !== design.projectPath || cap.slug !== design.slug) return { ok: false, reason: "wrong-design" };
    if (cap.purpose !== "canvas") return { ok: false, reason: "not-refreshable" };
    const at = now();
    const extend = (c: DesignPreviewCapability): void => { c.idleExpires = Math.min(at + CANVAS_IDLE_TTL, c.hardExpires); };
    extend(cap);
    // After a rotation the canvas refreshes with the new token while the document it loaded
    // with the old one is still on screen and may fetch lazy assets. Keep that one alive too,
    // up to its own hard cap.
    const previous = cap.predecessor ? resolve(cap.predecessor) : null;
    if (previous) extend(previous);
    if (at < cap.hardExpires - ROTATE_WINDOW) return { ok: true, capability: cap, rotated: false };
    const existing = cap.successor ? resolve(cap.successor) : null;
    if (existing) {
      extend(existing);
      return { ok: true, capability: existing, rotated: true };
    }
    const next = mint(design, "canvas");
    // mint() may have evicted the old token to make room; it is still the one being
    // refreshed, so put it back rather than strand the loaded document.
    if (!tokens.has(cap.token)) tokens.set(cap.token, cap);
    cap.successor = next.token;
    next.predecessor = cap.token;
    return { ok: true, capability: next, rotated: true };
  }

  return { mint, refresh, resolve, size: () => tokens.size };
}
