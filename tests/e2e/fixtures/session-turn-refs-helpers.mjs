// Shared helpers for the cross-session turn reference e2e (tests/e2e/session-turn-refs-e2e.mjs):
// the fixture's API, polling, the copied-link capture, pasting into a composer, finding a chat's
// panel, sending over a bare chat socket, and measuring where a turn sits in its scroll container.
import assert from "node:assert/strict";

/** The chat composer; while a turn runs its placeholder asks for a follow-up instead. */
export const COMPOSER = 'textarea:is([placeholder="Ask anything..."], [placeholder^="Follow-up"])';
export const PIN_PX = 16;
export const PIN_TOLERANCE_PX = 2;

/**
 * `onEvent(type, page, detail)` is optional: the walkthrough recorder
 * (fixtures/e2e-video-recorder.mjs) uses it to know when each scenario started and each check
 * passed or failed, on which page, so it can cut one clip per check out of the page's video.
 */
export function createKit({ web, artifacts, currentPage, onEvent }) {
  const results = [];
  const failures = [];
  const record = (name, detail = {}) => {
    results.push({ name, passed: true, ...detail });
    onEvent?.("check", currentPage(), { name, passed: true });
    console.log(`PASS ${name}`);
  };

  /**
   * One scenario: a failure is recorded with a screenshot and the run goes on to the next one, so a
   * product bug found in one scenario does not hide what the others would have found.
   */
  async function scenario(label, fn) {
    onEvent?.("start", currentPage(), { label });
    try {
      await fn();
    } catch (e) {
      const message = String(e?.stack ?? e);
      failures.push({ scenario: label, error: message });
      results.push({ name: `scenario ${label}`, passed: false, error: message });
      onEvent?.("check", currentPage(), { name: `scenario ${label}`, passed: false });
      console.log(`FAIL scenario ${label}: ${message}`);
      try { await currentPage()?.screenshot({ path: `${artifacts}/FAIL-${label.replace(/[^a-z0-9]+/gi, "-")}.png` }); } catch { /* page gone */ }
    }
  }

  async function until(label, fn, timeout = 30000, every = 100) {
    const start = Date.now();
    let last;
    while (Date.now() - start < timeout) {
      try { last = await fn(); if (last) return last; } catch (e) { last = e; }
      await new Promise((r) => setTimeout(r, every));
    }
    throw new Error(`Timeout: ${label} (last: ${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 400)})`);
  }

  async function api(path, init = {}) {
    const response = await fetch(web + path, { ...init, headers: { "Content-Type": "application/json", Connection: "close" } });
    const body = await response.json();
    assert(response.ok, `${path}: ${JSON.stringify(body)}`);
    return body;
  }
  const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });

  /** Queue scripted turns for a session: the next sends there run these, in order. */
  const plan = (sessionId, ...plans) => post("/__turn-test/plan", { sessionId, plans });

  /** The MCP calls scripted turns made, after `from`. */
  const callsSince = async (from) => (await api("/__turn-test/calls")).calls.slice(from);

  /**
   * A turn sent from a second device's own chat socket (opened by the fixture: Node 20 has no
   * WebSocket); `finished` resolves with the event types it saw once the turn is done.
   */
  function socketTurn(project, sessionId, content) {
    return { finished: post("/__turn-test/socket-turn", { project, sessionId, content }).then((r) => r.seen) };
  }

  const layoutOf = (page, project) => page.evaluate((name) => JSON.parse(localStorage.getItem(`ppm-panels-${name}`) ?? "null"), project);
  const panelOf = (layout, sessionId) => Object.values(layout?.panels ?? {}).find((p) => p.tabs.some((t) => t.type === "chat" && t.metadata?.sessionId === sessionId));

  /** The visible chat area of the panel showing `sessionId`. */
  async function chatArea(page, project, sessionId) {
    const panel = await until(`panel for ${sessionId}`, async () => panelOf(await layoutOf(page, project), sessionId), 15000);
    return page.locator(`[data-panel-drop-zone="${panel.id}"]`);
  }

  /** Every link Copy turn link wrote, in order (the clipboard is captured by an init script). */
  const copied = (page) => page.evaluate(() => window.__copiedTurnLinks ?? []);

  /** Paste `text` into a composer the way the browser delivers a paste: a `paste` event with clipboard data. */
  async function paste(composer, text) {
    await composer.click();
    await composer.evaluate((ta, value) => {
      const data = new DataTransfer();
      data.setData("text/plain", value);
      ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);
  }

  /** Wait for a composer to hold `n` ready chips; returns their text. */
  async function readyChips(area, n) {
    const chips = area.locator('[data-composer-turn-refs] [data-turn-chip="ready"]');
    await until(`${n} ready chips`, async () => (await chips.count()) === n, 20000);
    return chips.allInnerTexts();
  }

  /**
   * Where the row starting `turnId` sits below the top of its scroll container, in the history
   * window when one is open, else in the live list; null while it is not drawn.
   */
  const offsetOf = (page, turnId) => page.evaluate((id) => {
    const rows = [...document.querySelectorAll(`[data-turn-start="${CSS.escape(id)}"]`)].filter((r) => r.getClientRects().length && r.offsetParent);
    const row = rows.find((r) => r.closest("[data-history-window]")) ?? rows[0];
    if (!row) return null;
    let el = row.parentElement;
    while (el && !(getComputedStyle(el).overflowY === "auto" && el.clientHeight > 0)) el = el.parentElement;
    if (!el) return null;
    return {
      offset: row.getBoundingClientRect().top - el.getBoundingClientRect().top, inWindow: !!row.closest("[data-history-window]"),
      height: el.clientHeight, canScroll: el.scrollHeight > el.clientHeight + 1,
    };
  }, turnId);

  /**
   * Samples the row's offset every frame for `ms`, counting the images that finish loading in the
   * same container meanwhile; frames where the container has no height (a tab being moved) are skipped.
   */
  const sampleOffsets = (page, turnId, ms) => page.evaluate(({ id, ms }) => new Promise((done) => {
    const samples = [];
    let loads = 0;
    const onLoad = (e) => { if (e.target instanceof HTMLImageElement) loads++; };
    document.addEventListener("load", onLoad, true);
    const start = performance.now();
    const tick = () => {
      const rows = [...document.querySelectorAll(`[data-turn-start="${CSS.escape(id)}"]`)].filter((r) => r.getClientRects().length && r.offsetParent);
      const row = rows.find((r) => r.closest("[data-history-window]")) ?? rows[0];
      let el = row?.parentElement;
      while (el && !(getComputedStyle(el).overflowY === "auto" && el.clientHeight > 0)) el = el.parentElement;
      if (row && el) samples.push(Math.round((row.getBoundingClientRect().top - el.getBoundingClientRect().top) * 10) / 10);
      if (performance.now() - start < ms) requestAnimationFrame(tick);
      else { document.removeEventListener("load", onLoad, true); done({ samples, loads }); }
    };
    requestAnimationFrame(tick);
  }), { id: turnId, ms });

  const assertPinned = (label, offsets) => {
    assert(offsets.length > 0, `${label}: no samples`);
    const bad = offsets.filter((o) => Math.abs(o - PIN_PX) > PIN_TOLERANCE_PX);
    assert.equal(bad.length, 0, `${label}: offsets outside ${PIN_PX}±${PIN_TOLERANCE_PX}: ${JSON.stringify(bad.slice(0, 10))} of ${offsets.length}`);
  };

  const shot = (page, name) => page.screenshot({ path: `${artifacts}/${name}.png` });

  return { results, failures, scenario, record, until, api, post, plan, callsSince, socketTurn, layoutOf, panelOf, chatArea, copied, paste, readyChips, offsetOf, sampleOffsets, assertPinned, shot };
}

/** Init script: capture every clipboard write, and dismiss onboarding. */
export function pageInit() {
  if (window.top !== window) return;
  localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
  window.__copiedTurnLinks = [];
  const clipboard = {
    writeText: async (text) => { window.__copiedTurnLinks.push(text); },
    readText: async () => window.__copiedTurnLinks.at(-1) ?? "",
  };
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
}
