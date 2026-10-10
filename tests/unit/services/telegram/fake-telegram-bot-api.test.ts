/**
 * The fake Telegram checked against the Bot API behaviour other tests rely on, so a test that
 * passes against it is not passing because the fake is lenient.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseTelegramHtml, startFakeTelegram, type FakeTelegram } from "../../../helpers/fake-telegram-bot-api.ts";

let fake: FakeTelegram;
beforeEach(() => { fake = startFakeTelegram(); });
afterEach(() => fake.stop());

async function api(method: string, body: Record<string, unknown> = {}, token = fake.token): Promise<{ status: number; json: any }> {
  const res = await fetch(`${fake.url}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe("fake Telegram", () => {
  it("answers getMe and refuses a wrong token", async () => {
    expect((await api("getMe")).json.result).toMatchObject({ is_bot: true, username: "ppm_fake_bot" });
    expect(await api("getMe", {}, `1:${"x".repeat(35)}`)).toMatchObject({ status: 401, json: { ok: false, error_code: 401 } });
  });

  it("returns updates in order and forgets what an offset confirmed", async () => {
    fake.pushText(1, 1, "one");
    fake.pushText(1, 1, "two");
    const first = (await api("getUpdates", { offset: 0, timeout: 0 })).json.result;
    expect(first.map((u: any) => u.message.text)).toEqual(["one", "two"]);
    const again = (await api("getUpdates", { offset: first[1].update_id + 1, timeout: 0 })).json.result;
    expect(again).toEqual([]);
    expect((await api("getUpdates", { offset: 0, timeout: 0 })).json.result).toEqual([]);
  });

  it("holds a long poll until an update arrives, and times out empty", async () => {
    const started = Date.now();
    const poll = api("getUpdates", { offset: 0, timeout: 5 });
    await Bun.sleep(50);
    fake.pushText(1, 1, "wake");
    const res = await poll;
    expect(res.json.result.map((u: any) => u.message.text)).toEqual(["wake"]);
    expect(Date.now() - started).toBeLessThan(2000);

    const quiet = Date.now();
    expect((await api("getUpdates", { offset: res.json.result[0].update_id + 1, timeout: 1 })).json.result).toEqual([]);
    expect(Date.now() - quiet).toBeGreaterThanOrEqual(900);
  });

  it("ends a waiting poll with 409 when another reader polls", async () => {
    const first = api("getUpdates", { offset: 0, timeout: 5 });
    await Bun.sleep(30);
    const second = api("getUpdates", { offset: 0, timeout: 1 });
    expect(await first).toMatchObject({ status: 409, json: { ok: false, error_code: 409 } });
    expect((await second).json.ok).toBe(true);
  });

  it("delivers only the update types the bot asked for, remembered between polls", async () => {
    const sent = (await api("sendMessage", { chat_id: 5, text: "Go?", reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] } })).json.result;
    await api("getUpdates", { offset: 0, timeout: 0, allowed_updates: ["message"] });
    fake.pressButton(5, 5, sent.message_id, "go");
    fake.pushText(5, 5, "text");
    const got = (await api("getUpdates", { offset: 0, timeout: 0 })).json.result;
    expect(got.map((u: any) => Object.keys(u).filter((k) => k !== "update_id"))).toEqual([["message"]]);
  });

  it("turns a button press into a callback_query, answerable once", async () => {
    const sent = (await api("sendMessage", { chat_id: 5, text: "Allow?", reply_markup: { inline_keyboard: [[{ text: "Allow", callback_data: "allow:1" }]] } })).json.result;
    expect(() => fake.pressButton(5, 5, sent.message_id, "deny:1")).toThrow("no button");
    fake.pressButton(5, 5, sent.message_id, "allow:1");
    const [update] = (await api("getUpdates", { offset: 0, timeout: 0, allowed_updates: ["message", "callback_query"] })).json.result;
    expect(update.callback_query).toMatchObject({ data: "allow:1", from: { id: 5 }, message: { message_id: sent.message_id, text: "Allow?" } });
    expect((await api("answerCallbackQuery", { callback_query_id: update.callback_query.id })).json.ok).toBe(true);
    expect((await api("answerCallbackQuery", { callback_query_id: update.callback_query.id })).status).toBe(400);
  });

  it("refuses what Telegram refuses", async () => {
    const refusal = async (body: Record<string, unknown>) => (await api("sendMessage", { chat_id: 5, ...body })).json.description;
    expect(await refusal({ text: "a < b", parse_mode: "HTML" })).toContain("can't parse entities");
    expect(await refusal({ text: "<b><i>x</b></i>", parse_mode: "HTML" })).toContain("can't parse entities");
    expect(await refusal({ text: "<h1>x</h1>", parse_mode: "HTML" })).toContain("Unsupported start tag");
    expect(await refusal({ text: "x".repeat(4097) })).toBe("Bad Request: message is too long");
    expect(await refusal({ text: "ok", reply_markup: { inline_keyboard: [[{ text: "b", callback_data: "x".repeat(65) }]] } })).toBe("Bad Request: BUTTON_DATA_INVALID");
    // Visible length counts, not the markup around it.
    expect((await api("sendMessage", { chat_id: 5, text: `<b>${"x".repeat(4096)}</b>`, parse_mode: "HTML" })).json.ok).toBe(true);
  });

  it("counts message ids per chat, records edits and refuses one that changes nothing", async () => {
    const a = (await api("sendMessage", { chat_id: 7, text: "v1" })).json.result;
    fake.pushText(7, 7, "from the user");
    const b = (await api("sendMessage", { chat_id: 8, text: "other chat" })).json.result;
    expect([a.message_id, b.message_id]).toEqual([1, 1]);
    expect((await api("sendMessage", { chat_id: 7, text: "v2" })).json.result.message_id).toBe(3);

    expect((await api("editMessageText", { chat_id: 7, message_id: 1, text: "v1 edited" })).json.ok).toBe(true);
    expect((await api("editMessageText", { chat_id: 7, message_id: 1, text: "v1 edited" })).json.description).toContain("message is not modified");
    expect(fake.sent(7)[0]).toMatchObject({ text: "v1 edited", history: ["v1"] });
    expect(fake.lastText(7)).toBe("v2");
  });

  it("injects failures in order, then answers normally", async () => {
    fake.failNext("sendMessage", { code: 429, retryAfter: 2 });
    fake.failNext("sendMessage", { code: 400 });
    expect((await api("sendMessage", { chat_id: 1, text: "a" })).json).toMatchObject({ error_code: 429, parameters: { retry_after: 2 } });
    expect((await api("sendMessage", { chat_id: 1, text: "a" })).json.description).toContain("can't parse entities");
    expect((await api("sendMessage", { chat_id: 1, text: "a" })).json.ok).toBe(true);
    expect(fake.calls.filter((c) => c.method === "sendMessage").map((c) => c.failed)).toEqual([429, 400, undefined]);
  });

  it("serves a pushed photo through getFile and the file URL", async () => {
    fake.pushPhoto(3, 3, { bytes: new Uint8Array([1, 2, 3]) });
    const [update] = (await api("getUpdates", { offset: 0, timeout: 0 })).json.result;
    const file = (await api("getFile", { file_id: update.message.photo.at(-1).file_id })).json.result;
    const res = await fetch(`${fake.url}/file/bot${fake.token}/${file.file_path}`);
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2, 3]);
  });

  it("waitFor resolves with the value and times out with a clear error", async () => {
    setTimeout(() => void api("sendMessage", { chat_id: 9, text: "later" }), 20);
    expect(await fake.waitFor(() => fake.lastText(9), 1000)).toBe("later");
    await expect(fake.waitFor(() => false, 50)).rejects.toThrow("not met within 50 ms");
  });

  it("parses Telegram HTML the way Telegram does", () => {
    expect(parseTelegramHtml('<a href="https://x.dev?a=1&amp;b=2">x</a> &lt;&#33;&#x21;')).toEqual({ text: "x <!!" });
    expect(parseTelegramHtml("<pre><code class=\"language-ts\">a &gt; b</code></pre>")).toEqual({ text: "a > b" });
    expect(parseTelegramHtml("AT&T")).toHaveProperty("error");
  });
});
