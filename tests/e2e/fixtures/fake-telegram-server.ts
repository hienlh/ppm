/**
 * The fake Telegram Bot API (tests/helpers/fake-telegram-bot-api.ts) as a process of its own, for
 * the Assistant + Telegram e2e. It outlives the PPM fixture it serves, so a restarted PPM edits the
 * very messages it sent before the restart, and the e2e runner (Node) plays the phone through a
 * small control API on a second port:
 *
 *   POST /push   { chatId, userId, text, chatType?, extra? }  → the update (`extra.date` backdates it)
 *   POST /photo  { chatId, userId, caption? }                 → the update
 *   POST /press  { chatId, userId, messageId, data, stale? }  → the update, or 400 when no such button
 *   POST /fail   { method, failure: { code, retryAfter?, description? } }
 *   GET  /chat?id=<chat>   → { sent, deleted } for that chat
 *   GET  /answers          → every answerCallbackQuery, in order
 *   GET  /calls?from=<n>   → the Bot API calls from index n (method, chat, refusal), and the total
 *   GET  /commands         → what setMyCommands registered
 *   POST /exit
 *
 * Both servers listen on 127.0.0.1 only. The bot token is the fake's own (`FAKE_BOT_TOKEN`).
 */
import { startFakeTelegram } from "../../helpers/fake-telegram-bot-api.ts";

const apiPort = Number(process.env.FAKE_TELEGRAM_API_PORT ?? 0);
const fake = startFakeTelegram({ port: Number.isInteger(apiPort) ? apiPort : 0, username: "ppm_e2e_bot" });

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    return ((await req.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const control = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.FAKE_TELEGRAM_CONTROL_PORT ?? 0),
  async fetch(req) {
    const url = new URL(req.url);
    try {
      switch (`${req.method} ${url.pathname}`) {
        case "POST /push": {
          const b = await body(req);
          return json(fake.pushText(Number(b.chatId), Number(b.userId), String(b.text ?? ""), (b.chatType as never) ?? "private", (b.extra as Record<string, unknown>) ?? {}));
        }
        case "POST /photo": {
          const b = await body(req);
          return json(fake.pushPhoto(Number(b.chatId), Number(b.userId), typeof b.caption === "string" ? { caption: b.caption } : {}));
        }
        case "POST /press": {
          const b = await body(req);
          return json(fake.pressButton(Number(b.chatId), Number(b.userId), Number(b.messageId), String(b.data), { stale: b.stale === true }));
        }
        case "POST /fail": {
          const b = await body(req);
          fake.failNext(String(b.method), b.failure as never);
          return json({ ok: true });
        }
        case "GET /chat": {
          const id = Number(url.searchParams.get("id"));
          return json({ sent: fake.sent(id), deleted: fake.deleted.filter((m) => m.chat_id === id) });
        }
        case "GET /answers":
          return json(fake.answers);
        case "GET /calls": {
          const from = Number(url.searchParams.get("from") ?? 0);
          const calls = fake.calls.slice(from).map((c) => ({
            method: c.method,
            chatId: c.body.chat_id === undefined ? null : Number(c.body.chat_id),
            failed: c.failed ?? null,
            text: typeof c.body.text === "string" ? c.body.text : null,
            // Whatever the body held, so a run can prove the token never went into one.
            raw: JSON.stringify(c.body),
          }));
          return json({ total: fake.calls.length, calls });
        }
        case "GET /commands":
          return json(fake.commands);
        case "POST /exit":
          setTimeout(() => { fake.stop(); control.stop(true); process.exit(0); }, 20);
          return json({ ok: true });
        default:
          return json({ error: "unknown control route" }, 404);
      }
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  },
});

console.log(`FAKE_TELEGRAM ${JSON.stringify({ api: fake.url, control: `http://127.0.0.1:${control.port}`, token: fake.token })}`);
process.on("SIGTERM", () => { fake.stop(); control.stop(true); process.exit(0); });
process.on("SIGINT", () => { fake.stop(); control.stop(true); process.exit(0); });
