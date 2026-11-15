import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getPpmDir } from "../../ppm-dir.ts";
import { localServerBaseUrl } from "../../server-listen-address.ts";
import { getDesign } from "../design-store.service.ts";
import type { DesignVariant } from "../../../shared/design-variants.ts";
import { designVariantsOf } from "../../../shared/design-variants.ts";
import type { DesignPreviewCapability } from "../preview/design-preview-tokens.ts";
import { DESIGN_CDN_HOSTS } from "../../../shared/design-cdn-hosts.ts";
import { findHeadlessBrowser, launchHeadlessBrowser, NO_BROWSER_MESSAGE, type CdpConnection } from "./headless-browser.ts";

/**
 * PNG screenshots of a design's variants, rendered on the server by a headless browser loading
 * each variant through a short-lived `standalone` preview token (one per page) — the same page
 * "Open in new tab" shows, with the design CSP and no bridge, nonce or canvas involved. The
 * canvas's own guards are untouched: nothing here goes through the canvas frame.
 *
 * The browser runs on the server's network, so the page may reach nothing the canvas could not:
 * every request is held (`Fetch`) and let through only to that token's own files and the design
 * CDNs, downloads are refused, and a page that navigated anywhere else is not captured — a design
 * that sends itself to `http://169.254.169.254/` or a LAN service gets a blocked load, never a
 * picture of what is there.
 *
 * Each shot is kept as `<ppm dir>/design-shots/<id>.png` beside a `<id>.json` saying which design
 * and variant it shows. The id is 128 random bits and is the only thing that names the file, so
 * it doubles as the link that shows the picture (`/api/design-shots/<id>.png`, served without
 * login so a phone opening it from Telegram sees it). Shots older than {@link SHOT_TTL_MS} are
 * deleted on the next capture.
 */

export const SHOT_TTL_MS = 7 * 24 * 60 * 60_000;
/** Shots kept at most; the oldest go first. */
export const MAX_KEPT_SHOTS = 300;
/** One capture call, browser start to close; past it the browser is killed and the call fails. */
export const CAPTURE_DEADLINE_MS = 120_000;
export const MAX_SHOTS_PER_CALL = 6;
export const SHOT_WIDTH = 1280;
export const SHOT_MAX_HEIGHT = 4000;
const LOAD_TIMEOUT_MS = 20_000;
const SETTLE_MS = 600;
export const SHOT_ID_RE = /^[0-9a-f]{32}$/;

export interface DesignShot {
  id: string;
  projectPath: string;
  slug: string;
  designTitle: string;
  file: string;
  label: string;
  width: number;
  height: number;
  createdAt: string;
}

export interface CapturedShot extends DesignShot {
  png: Uint8Array;
}

export const shotsDir = (): string => join(getPpmDir(), "design-shots");
export const shotPngPath = (id: string): string => join(shotsDir(), `${id}.png`);
const metaPath = (id: string): string => join(shotsDir(), `${id}.json`);

/** What the capture needs from the rest of PPM; the real one mints through the preview route's store. */
export interface ShotDeps {
  mintStandalone(projectPath: string, slug: string): DesignPreviewCapability;
  baseUrl(): string | null;
  browser(): string | null;
}

let depsRef: ShotDeps | null = null;
async function liveDeps(): Promise<ShotDeps> {
  if (depsRef) return depsRef;
  const { designPreviewRoutes } = await import("../../../server/routes/design-preview.ts");
  depsRef = {
    mintStandalone: (projectPath, slug) => designPreviewRoutes.store.mint({ projectPath, slug }, "standalone"),
    baseUrl: localServerBaseUrl,
    browser: () => findHeadlessBrowser(),
  };
  return depsRef;
}

/** The preview route's address for one file of the design, as `urlFor` there builds it. */
const contentUrl = (base: string, cap: DesignPreviewCapability, file: string): string =>
  `${base}/api/design-preview/content/${cap.token}/${cap.slug}/${file.split("/").map(encodeURIComponent).join("/")}`;

/** Whether the page may load `url`: its own token's files, the design CDNs, or inline data. */
export function shotRequestAllowed(url: string, ownPrefix: string): boolean {
  if (url.startsWith(ownPrefix)) return true;
  if (/^(?:data|blob):/i.test(url) || url === "about:blank") return true;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === "https:" && (DESIGN_CDN_HOSTS as readonly string[]).includes(parsed.hostname);
}

async function renderPng(cdp: CdpConnection, sessionId: string, url: string, ownPrefix: string): Promise<{ png: Uint8Array; height: number }> {
  // Every request waits here first: only the design's own files and the CDNs go through.
  const stopGuard = cdp.on("Fetch.requestPaused", sessionId, (params) => {
    const requestId = String(params.requestId);
    const target = String((params.request as { url?: unknown } | undefined)?.url ?? "");
    void (shotRequestAllowed(target, ownPrefix)
      ? cdp.send("Fetch.continueRequest", { requestId }, sessionId)
      : cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sessionId)).catch(() => {});
  });
  try {
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
    return await renderGuarded(cdp, sessionId, url, ownPrefix);
  } finally {
    stopGuard();
  }
}

async function renderGuarded(cdp: CdpConnection, sessionId: string, url: string, ownPrefix: string): Promise<{ png: Uint8Array; height: number }> {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: SHOT_WIDTH, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  const loaded = cdp.waitFor("Page.loadEventFired", sessionId, LOAD_TIMEOUT_MS);
  const nav = await cdp.send("Page.navigate", { url }, sessionId);
  if (typeof nav.errorText === "string" && nav.errorText) throw new Error(`The page did not load: ${nav.errorText}`);
  await loaded;
  // Web fonts, then a moment for scripts that lay the page out after load.
  await cdp.send("Runtime.evaluate", { expression: "document.fonts ? document.fonts.ready.then(() => 1) : 1", awaitPromise: true }, sessionId, 8000)
    .catch(() => {});
  await Bun.sleep(SETTLE_MS);
  const measured = await cdp.send("Runtime.evaluate", {
    expression: "Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)",
    returnByValue: true,
  }, sessionId);
  const raw = Number((measured.result as { value?: unknown } | undefined)?.value);
  const height = Math.max(200, Math.min(SHOT_MAX_HEIGHT, Number.isFinite(raw) ? Math.ceil(raw) : 900));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: SHOT_WIDTH, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  // Two frames after the resize, so the picture is the page as painted at its full height.
  await cdp.send("Runtime.evaluate", {
    expression: "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))", awaitPromise: true,
  }, sessionId, 5000).catch(() => {});
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png", captureBeyondViewport: false, clip: { x: 0, y: 0, width: SHOT_WIDTH, height, scale: 1 },
  }, sessionId, 30_000);
  if (typeof shot.data !== "string") throw new Error("The browser returned no picture");
  // A page that sent itself elsewhere is not pictured: its address would be the picture's subject.
  const at = await cdp.send("Runtime.evaluate", { expression: "location.href", returnByValue: true }, sessionId);
  const href = String((at.result as { value?: unknown } | undefined)?.value ?? "");
  if (!href.startsWith(ownPrefix)) throw new Error("The page navigated away from the design, so it was not captured.");
  return { png: new Uint8Array(Buffer.from(shot.data, "base64")), height };
}

/** Deletes shots past their age, then the oldest past {@link MAX_KEPT_SHOTS}; never throws. */
export async function pruneShots(now = Date.now()): Promise<void> {
  const names = (await readdir(shotsDir()).catch(() => [] as string[])).filter((n) => /^[0-9a-f]{32}\.png$/.test(n));
  const kept: Array<{ id: string; at: number }> = [];
  for (const name of names) {
    const st = await stat(join(shotsDir(), name)).catch(() => null);
    if (st) kept.push({ id: name.slice(0, 32), at: st.mtimeMs });
  }
  kept.sort((a, b) => b.at - a.at);
  for (const [i, shot] of kept.entries()) {
    if (i < MAX_KEPT_SHOTS && now - shot.at <= SHOT_TTL_MS) continue;
    await rm(shotPngPath(shot.id), { force: true }).catch(() => {});
    await rm(metaPath(shot.id), { force: true }).catch(() => {});
  }
}

/**
 * Renders `variants` of the design (every variant by default, at most {@link MAX_SHOTS_PER_CALL})
 * and keeps each as a shot. Throws with a message for the AI when the design, the server or the
 * browser is not there.
 */
export async function captureDesignShots(
  projectPath: string, slug: string, wanted?: string[], deps?: ShotDeps,
): Promise<CapturedShot[]> {
  const d = deps ?? (await liveDeps());
  const design = await getDesign(projectPath, slug);
  const all: DesignVariant[] = designVariantsOf(design);
  const variants = wanted?.length ? all.filter((v) => wanted.includes(v.file)) : all;
  const missing = wanted?.filter((w) => !all.some((v) => v.file === w)) ?? [];
  if (missing.length) {
    throw new Error(`Design "${slug}" has no variant ${missing.map((m) => `"${m}"`).join(", ")}; its variants are ${all.map((v) => v.file).join(", ")}.`);
  }
  if (variants.length > MAX_SHOTS_PER_CALL) {
    throw new Error(`Design "${slug}" has ${variants.length} variants; name at most ${MAX_SHOTS_PER_CALL} in \`variants\`.`);
  }
  const base = d.baseUrl();
  if (!base) throw new Error("PPM's server is not listening, so the design cannot be rendered.");
  const binary = d.browser();
  if (!binary) throw new Error(NO_BROWSER_MESSAGE);

  await mkdir(shotsDir(), { recursive: true });
  await pruneShots();
  const browser = await launchHeadlessBrowser(binary);
  const out: CapturedShot[] = [];
  // A page that never settles must not hold the browser, nor every later screenshot behind it.
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; void browser.close(); }, CAPTURE_DEADLINE_MS);
  try {
    await browser.cdp.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
    for (const variant of variants) {
      // A fresh tab per page: a tab reused for the next page can keep tiles of the one before.
      const { targetId } = await browser.cdp.send("Target.createTarget", { url: "about:blank" }) as { targetId: string };
      const { sessionId } = await browser.cdp.send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string };
      await browser.cdp.send("Page.enable", {}, sessionId);
      // One token per page: it is short-lived and names this design only.
      const cap = d.mintStandalone(projectPath, slug);
      const ownPrefix = `${base}/api/design-preview/content/${cap.token}/`;
      const { png, height } = await renderPng(browser.cdp, sessionId, contentUrl(base, cap, variant.file), ownPrefix);
      await browser.cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      const id = randomBytes(16).toString("hex");
      const shot: DesignShot = {
        id, projectPath, slug, designTitle: design.title, file: variant.file, label: variant.label,
        width: SHOT_WIDTH, height, createdAt: new Date().toISOString(),
      };
      await writeFile(shotPngPath(id), png);
      await writeFile(metaPath(id), JSON.stringify(shot));
      out.push({ ...shot, png });
    }
  } catch (e) {
    if (timedOut) throw new Error(`The design took longer than ${CAPTURE_DEADLINE_MS / 1000} s to render.`);
    throw e;
  } finally {
    clearTimeout(deadline);
    await browser.close();
  }
  return out;
}

const parseShot = (id: string, raw: string | null): DesignShot | null => {
  if (!raw) return null;
  try {
    const shot = JSON.parse(raw) as DesignShot;
    if (shot.id !== id || Date.now() - Date.parse(shot.createdAt) > SHOT_TTL_MS) return null;
    return shot;
  } catch {
    return null;
  }
};

/** A kept shot's record, or null when the id names none (or one past its age). */
export async function readShot(id: string): Promise<DesignShot | null> {
  if (!SHOT_ID_RE.test(id)) return null;
  return parseShot(id, await readFile(metaPath(id), "utf8").catch(() => null));
}

/** {@link readShot} for a synchronous caller (the report tool checks a card's pictures as it files it). */
export function readShotSync(id: string): DesignShot | null {
  if (!SHOT_ID_RE.test(id)) return null;
  let raw: string | null = null;
  try { raw = readFileSync(metaPath(id), "utf8"); } catch { raw = null; }
  return parseShot(id, raw);
}
