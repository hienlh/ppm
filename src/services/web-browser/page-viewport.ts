/**
 * Lays every page out at the controlling viewer's size, as a phone or a desktop.
 *
 * A phone viewer gets the mobile layout the site would show a phone: `mobile: true` in the
 * device metrics, touch emulation (without it pages do not believe they are on a touch device
 * and keep their hover menus), and a mobile user agent built from the real Chrome version, so a
 * site that sniffs the UA does not see a desktop Chrome claiming to be small.
 */
import type { CdpConnection } from "./cdp-connection.ts";
import type { Viewport } from "./input-bridge.ts";

export const DEFAULT_VIEWPORT: Viewport = { cssWidth: 1280, cssHeight: 800, dpr: 1, mobile: false };

let mobileUa: string | null = null;

async function mobileUserAgent(cdp: CdpConnection): Promise<string> {
  if (mobileUa) return mobileUa;
  try {
    const v = await cdp.send<{ product: string }>("Browser.getVersion");
    const version = v.product.split("/")[1] ?? "131.0.0.0";
    const major = version.split(".")[0];
    mobileUa = `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;
  } catch {
    mobileUa = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
  }
  return mobileUa;
}

export async function applyViewport(cdp: CdpConnection, sessionId: string, vp: Viewport): Promise<void> {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: vp.cssWidth,
    height: vp.cssHeight,
    deviceScaleFactor: vp.dpr,
    mobile: vp.mobile,
  }, sessionId).catch(() => {});
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: vp.mobile, maxTouchPoints: vp.mobile ? 5 : 1 }, sessionId).catch(() => {});
  if (vp.mobile) {
    await cdp.send("Emulation.setUserAgentOverride", { userAgent: await mobileUserAgent(cdp), platform: "Android" }, sessionId).catch(() => {});
  } else {
    await cdp.send("Emulation.setUserAgentOverride", { userAgent: "" }, sessionId).catch(() => {});
  }
}
