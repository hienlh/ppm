/**
 * Installs the sound tap in every page and forwards what the tab on screen plays to the viewer
 * in control. A binding with a random name per browser run carries the PCM out of the page;
 * the server accepts only well-formed, size-capped chunks from it, since any script on the page
 * can call it too (at worst sending the viewer sound that page could have played anyway).
 */
import { randomBytes } from "node:crypto";
import type { ViewerHub } from "../viewer-hub.ts";
import { encodeSoundFrame } from "../../../shared/web-browser-binary-frames.ts";
import { audioTapSource } from "./audio-tap-script.ts";

export const AUDIO_SAMPLE_RATE = 24_000;
/** 85 ms of mono 16-bit at 24 kHz is 4 KB; anything far larger is not ours. */
const MAX_CHUNK_BASE64 = 64 * 1024;
/** The tap sends ~12 chunks a second; a page calling the binding faster is dropped, not relayed. */
const MAX_CHUNKS_PER_SECOND = 20;

export function installAudioRelay(hub: ViewerHub): void {
  const host = hub.host;
  let bindingName = `__ppmAudio_${randomBytes(6).toString("hex")}`;
  let seq = 0;
  let off: (() => void) | null = null;

  host.addPageSetup(async (sessionId) => {
    const cdp = host.cdp;
    if (!cdp || !host.settings().audio) return;
    await cdp.send("Runtime.enable", {}, sessionId).catch(() => {});
    await cdp.send("Runtime.addBinding", { name: bindingName }, sessionId).catch(() => {});
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: audioTapSource(bindingName), runImmediately: true }, sessionId).catch(() => {});
  });

  host.on("state", (state: string) => {
    // A new name per run, chosen before the first page is set up.
    if (state === "starting") bindingName = `__ppmAudio_${randomBytes(6).toString("hex")}`;
    off?.();
    off = null;
    const cdp = host.cdp;
    if (state !== "running" || !cdp) return;
    let windowStart = 0;
    let inWindow = 0;
    off = cdp.onEvent((e) => {
      if (e.method !== "Runtime.bindingCalled") return;
      const now = Date.now();
      if (now - windowStart >= 1000) { windowStart = now; inWindow = 0; }
      if (++inWindow > MAX_CHUNKS_PER_SECOND) return;
      const p = e.params as { name?: string; payload?: string };
      if (p.name !== bindingName || typeof p.payload !== "string" || p.payload.length > MAX_CHUNK_BASE64) return;
      const active = host.activeTabId ? host.tabs?.get(host.activeTabId) : undefined;
      if (!active || active.sessionId !== e.sessionId || !host.settings().audio) return;
      const pcm = Buffer.from(p.payload, "base64");
      if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) return;
      seq = (seq + 1) >>> 0;
      hub.controller?.sendBinary(encodeSoundFrame(seq, AUDIO_SAMPLE_RATE, 1, pcm));
    });
  });
}
