// Shared helpers of tests/e2e/assistant-manager-loop-e2e.mjs: the fixture's routes, PPM's own
// Assistant routes, the moved clock, the browser's Assistant window and its cards.
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { until, sleep } from "../assistant-telegram/harness.mjs";

export { until, sleep };

/** Everything a step needs, built once by the runner. */
export function loopKit({ web, fx, tg, page, shotsDir, owner, record }) {
  const data = async (path, init) => (await fx.api(path, init)).data;
  const kit = {
    web, fx, tg, page, owner, record,
    /** The chat's own turns as the scripted provider saw them, oldest first. */
    turnsIn: async (sessionId) => (await fx.state()).turns.filter((t) => t.sessionId === sessionId),
    callsOf: (label) => fx.recordsOf(label),
    /** Queues a scripted turn: `match` (message or shared context), `sessionId`, `reply` (its closing words). */
    script: (label, ops, opts = {}) => fx.api("/__assistant-test/script", { method: "POST", body: JSON.stringify({ label, ops, ...opts }) }),
    /** Every call of the turn `label`, once each has its answer. */
    async answered(label, count, timeout = 30000) {
      return until(`${label}: ${count} call(s) answered`, async () => {
        const mine = await fx.recordsOf(label);
        return mine.length === count && mine.every((c) => c.done) ? mine : null;
      }, timeout);
    },
    /** A message typed into a project chat over the chat socket. */
    say: (project, sessionId, text, permissionMode) =>
      fx.post("/__assistant-test/say", { project, sessionId, text, ...(permissionMode ? { permissionMode } : {}) }),
    /** Moves the Assistant's clock forward; answers the new time (ms). */
    advance: async (ms) => (await fx.post("/__assistant-test/clock", { advanceMs: ms })).now,
    now: async () => (await fx.api("/__assistant-test/clock")).now,
    cards: async (query = "") => (await data(`/api/assistant/cards${query}`)).cards,
    waiting: () => data("/api/assistant/waiting"),
    managers: async () => (await data("/api/assistant/managers")).managers,
    notes: async () => (await data("/api/assistant/notes")).notes,
    rules: (project) => data(`/api/assistant/managers/${project}/rules`),
    /** Changes some Assistant settings the way Settings does: the stored row sent back whole. */
    async patchSettings(patch) {
      const { settings } = await data("/api/assistant/settings");
      return data("/api/assistant/settings", { method: "PUT", body: JSON.stringify({ ...settings, ...patch }) });
    },
    /** The newest card of `kind` (optionally whose title has `title`), once it exists. */
    async cardOf(kind, title, timeout = 30000) {
      return until(`a ${kind} card${title ? ` "${title}"` : ""}`, async () =>
        (await kit.cards()).find((c) => c.kind === kind && (!title || c.title.includes(title))), timeout);
    },
    /** The Assistant window on the page, and its parts. */
    body: () => page.locator("[data-assistant-body]:visible").first(),
    // The composer keeps a phone textarea and a desktop one; only the layout's own is visible.
    composer: () => kit.body().locator('textarea[aria-label="Message"]:visible').first(),
    streamCard: (kind, text) => kit.body().locator(`[data-assistant-card="${kind}"]`, text ? { hasText: text } : {}).last(),
    async shot(name) {
      await page.screenshot({ path: `${shotsDir}/${name}.png` });
    },
    /** Types into the Assistant's composer; its turn runs `ops` (scripted by the message's own words). */
    async askAssistant(label, ops, message, extra = {}) {
      await kit.script(label, ops, { match: message, ...extra });
      const box = kit.composer();
      await box.waitFor({ timeout: 30000 });
      await box.fill(message);
      await box.press("Enter");
      await until(`${label}: turn started`, () => fx.turnOf(label), 30000);
    },
    /** A whole manager turn typed by the user into its chat: queued ops, then the closing words seen. */
    async managerTurn(project, sessionId, label, ops, text, permissionMode) {
      await kit.script(label, ops, { match: text, sessionId });
      await kit.say(project, sessionId, text, permissionMode);
      return until(`${label} ran`, () => fx.turnOf(label), 30000);
    },
    /** A ppm-sessions call's JSON answer. */
    parse: (rec) => JSON.parse(rec.text),
    /** Waits for the session to have no turn running (the fixture's live view of the chat). */
    async idle(sessionId, timeout = 30000) {
      await until(`${sessionId} idle`, async () => {
        const live = (await fx.tg("live")).find((l) => l.sessionId === sessionId);
        return !live || (!live.running && !live.card);
      }, timeout, 200);
    },
  };
  return kit;
}

/** `git status --porcelain` of a project folder: what git would see as new or changed. */
export function gitStatus(dir) {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" }).trim();
}

/** Two hour-and-minute strings in UTC, the zone the e2e sets: `ms` and `ms + plus`. */
export const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);

/** The Telegram copy of a card: the newest message of the chat that names `title`. */
export async function telegramCard(tg, chat, title, timeout = 30000) {
  return tg.waitFor(chat, `card "${title}"`, (m) => m.text.includes(title), timeout);
}

export function assertNoButtons(message, why) {
  const labels = message?.reply_markup?.inline_keyboard?.flat().map((b) => b.text) ?? [];
  assert.deepEqual(labels, [], why);
}
