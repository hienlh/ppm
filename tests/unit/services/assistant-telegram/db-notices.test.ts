/**
 * A chat's database tool waits on the user: Telegram gets a notice — never a button that answers
 * it, never a request for a password — naming the project, the chat and the connection, with a
 * link to the chat in PPM. Quiet hours hold an approval's notice and drop the rest.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { clientFor, connectChat, disconnectChat, freshChat, queueFor, texts, useFakeTelegram } from "./bridge-test-kit.ts";
import {
  ANSWER_IN_PPM, AssistantTelegramDbNotices, DB_NOTICE_SQL_MAX, LOGIN_IN_PPM, PASSWORD_WITHHELD, type DescribedChat,
} from "../../../../src/services/assistant-telegram/assistant-telegram-db-notices.ts";
import { createDbAttentionEvents, type DbAttentionEvents } from "../../../../src/services/db-ai-tools/db-attention-events.ts";
import { getDb } from "../../../../src/services/db.service.ts";
import type { DbExecuteApprovalInput } from "../../../../src/shared/db-ai-tools.ts";

const fake = useFakeTelegram();
const client = clientFor(fake);

let notices: AssistantTelegramDbNotices[] = [];
beforeEach(() => { getDb().query("DELETE FROM clawbot_paired_chats").run(); });
afterEach(() => { for (const n of notices) n.detach(); notices = []; });

const INPUT: DbExecuteApprovalInput = {
  connectionId: 3, connectionName: "Prod <pg>", dbType: "postgres", group: "Live", color: null, readonly: true,
  database: "billing", sql: "UPDATE invoices SET paid = true WHERE id = 42", reason: "Mark the invoice the customer paid by wire", expectedRows: 1,
  passwordRequired: true,
};

function fakeQuiet(quietUntil: number | null) {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const waiting = new Set<string>();
  return {
    waiting,
    deps: {
      clock: { now: () => now, setTimer: (fn: () => void, ms: number) => { const t = { at: now + ms, fn, live: true }; timers.push(t); return () => { t.live = false; }; } },
      quietEnd: () => (quietUntil !== null && now < quietUntil ? quietUntil : null),
      stillWaiting: (_s: string, requestId: string) => waiting.has(requestId),
    },
    advance(ms: number) {
      now += ms;
      for (const t of timers) if (t.live && t.at <= now) { t.live = false; t.fn(); }
    },
  };
}

function setup(opts: { quietUntil?: number | null; link?: string; chat?: DescribedChat } = {}) {
  const queue = queueFor(client);
  const events = createDbAttentionEvents();
  const quiet = fakeQuiet(opts.quietUntil ?? null);
  const links: Array<{ project: string; provider: string | null; id: string }> = [];
  const n = new AssistantTelegramDbNotices({
    queue, events, quiet: quiet.deps,
    chatLink: async (project, provider, id) => {
      links.push({ project, provider, id });
      return opts.link ?? `http://localhost:8080/project/${project}?openChat=${provider}/${id}`;
    },
    describe: () => opts.chat ?? { project: "billing-api", providerId: "claude", title: "Fix the <stuck> invoices" },
  });
  n.attach();
  notices.push(n);
  const shown = (over: Partial<DbAttentionEvents["approval_shown"]> = {}): DbAttentionEvents["approval_shown"] =>
    ({ sessionId: "chat-1", requestId: `r-${crypto.randomUUID()}`, input: INPUT, expiresAt: 30 * 60_000, ...over });
  return { queue, events, quiet, links, shown };
}

const allButtons = (chatId: string) => fake.sent(Number(chatId)).flatMap((m) => fake.buttons(Number(chatId), m.message_id).flat().map((b) => b.text));

describe("a db_execute approval on Telegram", () => {
  it("is a notice to every connected chat, naming the project, chat, connection and SQL, with no way to answer it", async () => {
    const a = connectChat(freshChat());
    const b = connectChat(freshChat());
    const revoked = connectChat(freshChat());
    disconnectChat(revoked);
    const t = setup();
    t.events.emit("approval_shown", t.shown());
    await fake.waitFor(() => texts(fake, a).length === 1 && texts(fake, b).length === 1);
    await t.queue.whenIdle();
    expect(texts(fake, revoked)).toEqual([]);
    const text = texts(fake, a)[0]!;
    expect(text).toContain("A database change is waiting for your approval");
    expect(text).toContain("Chat “Fix the <stuck> invoices” in billing-api wants to run this on Prod <pg> (database billing):");
    expect(text).toContain("UPDATE invoices SET paid = true WHERE id = 42");
    expect(text).toContain("Why: Mark the invoice the customer paid by wire");
    expect(text).toContain("Nothing runs unless you approve within 30 minutes.");
    expect(text).toContain(ANSWER_IN_PPM);
    expect(text).toContain("Open in PPM: http://localhost:8080/project/billing-api?openChat=claude/chat-1");
    expect(allButtons(a)).toEqual([]);
    // One link for the notice, however many chats it goes to.
    expect(t.links).toEqual([{ project: "billing-api", provider: "claude", id: "chat-1" }]);
  });

  it("puts a public link on an Open in PPM button, and only that button", async () => {
    const chat = connectChat(freshChat());
    const t = setup({ link: "https://ppm.example.com/project/billing-api?openChat=claude/chat-1" });
    t.events.emit("approval_shown", t.shown());
    await fake.waitFor(() => texts(fake, chat).length === 1);
    await t.queue.whenIdle();
    expect(allButtons(chat)).toEqual(["Open in PPM"]);
    expect(texts(fake, chat)[0]).not.toContain("https://ppm.example.com");
  });

  it("cuts a long script short and hides a secret in it", async () => {
    const chat = connectChat(freshChat());
    const t = setup();
    const secret = "sk-ant-api03-" + "A".repeat(90);
    const sql = `UPDATE settings SET api_key = '${secret}';\n` + "INSERT INTO log VALUES (1);\n".repeat(200);
    t.events.emit("approval_shown", t.shown({ input: { ...INPUT, sql } }));
    await fake.waitFor(() => texts(fake, chat).length === 1);
    await t.queue.whenIdle();
    const text = texts(fake, chat)[0]!;
    expect(text).not.toContain(secret);
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(DB_NOTICE_SQL_MAX + 800);
  });

  it("withholds a script and a reason that set or use a password", async () => {
    const chat = connectChat(freshChat());
    const t = setup();
    const sql = [
      "CREATE ROLE reporter LOGIN PASSWORD 'Hunter2-secret';",
      "ALTER USER app WITH ENCRYPTED PASSWORD 'S3cr3t!';",
      "CREATE USER 'ro'@'%' IDENTIFIED BY 'mysqlPw123';",
      "ALTER USER 'x'@'%' IDENTIFIED WITH caching_sha2_password BY \"plugPw\";",
      "CREATE USER MAPPING FOR app SERVER s OPTIONS (user 'u', password 'fdwpw');",
      "SET PASSWORD FOR 'y'@'%' = 'setPw';",
      "SELECT PASSWORD('oldFnPw');",
      "ALTER ROLE q PASSWORD 'it''s-quoted';",
      "CREATE USER z IDENTIFIED BY 'back\\'slash';",
    ].join("\n");
    t.events.emit("approval_shown", t.shown({ input: { ...INPUT, sql, reason: "Give reporter the password 'Hunter2-secret'" } }));
    await fake.waitFor(() => texts(fake, chat).length === 1);
    await t.queue.whenIdle();
    const text = texts(fake, chat)[0]!;
    for (const pw of ["Hunter2-secret", "S3cr3t!", "mysqlPw123", "plugPw", "fdwpw", "setPw", "oldFnPw", "it''s-quoted", "s-quoted", "slash"]) {
      expect(text).not.toContain(pw);
    }
    // No pattern is trusted with every way SQL spells a password: neither the script nor the reason is shown.
    expect(text).not.toContain("CREATE ROLE");
    expect(text).not.toContain("Give reporter");
    expect(text.split(PASSWORD_WITHHELD)).toHaveLength(3);
    expect(text).toContain("wants to run this on Prod <pg> (database billing):");
    expect(text).toContain(ANSWER_IN_PPM);
  });

  it("withholds a script that sets a password in a form no pattern knows", async () => {
    const chat = connectChat(freshChat());
    const t = setup();
    const sql = "ALTER ROLE a PASSWORD 'pa\\'; ALTER ROLE b PASSWORD E'secret16'; ALTER USER c IDENTIFIED BY 'n' REPLACE 'old9';";
    t.events.emit("approval_shown", t.shown({ input: { ...INPUT, sql, reason: "rotate" } }));
    await fake.waitFor(() => texts(fake, chat).length === 1);
    await t.queue.whenIdle();
    const text = texts(fake, chat)[0]!;
    for (const pw of ["secret16", "old9", "pa\\"]) expect(text).not.toContain(pw);
    expect(text).toContain(PASSWORD_WITHHELD);
    expect(text).toContain("Why: rotate");
  });

  it("names and links the chat by the id it goes by now, after a rename", async () => {
    const chat = connectChat(freshChat());
    const queue = queueFor(client);
    const events = createDbAttentionEvents();
    const described: string[] = [];
    const links: string[] = [];
    const n = new AssistantTelegramDbNotices({
      queue, events, quiet: fakeQuiet(null).deps,
      canonical: (id) => (id === "draft" ? "thread-9" : id),
      describe: (id) => { described.push(id); return { project: "api", providerId: "codex", title: "Fix" }; },
      chatLink: async (_p, _pr, id) => { links.push(id); return `http://localhost:8080/c/${id}`; },
    });
    n.attach();
    notices.push(n);
    events.emit("login_needed", { sessionId: "draft", connectionId: 1, connectionName: "Pg" });
    await fake.waitFor(() => texts(fake, chat).length === 1);
    await queue.whenIdle();
    expect(described).toEqual(["thread-9"]);
    expect(links).toEqual(["thread-9"]);
  });

  it("sends nothing when no chat is connected", async () => {
    const t = setup();
    t.events.emit("approval_shown", t.shown());
    await t.queue.whenIdle();
    expect(t.links).toEqual([]);
  });

  it("reminds once more before it gives up, saying how long is left", async () => {
    const chat = connectChat(freshChat());
    const t = setup();
    const p = t.shown();
    t.quiet.advance(25 * 60_000);
    t.events.emit("approval_reminder", p);
    await fake.waitFor(() => texts(fake, chat).length === 1);
    await t.queue.whenIdle();
    const text = texts(fake, chat)[0]!;
    expect(text).toContain("Still waiting: a database change");
    expect(text).toContain("Chat “Fix the <stuck> invoices” in billing-api still waits for your approval to change Prod <pg> (database billing).");
    expect(text).toContain("PPM gives up in 5 minutes and nothing runs.");
    expect(text).toContain(ANSWER_IN_PPM);
    expect(allButtons(chat)).toEqual([]);
  });
});

describe("quiet hours", () => {
  it("hold an approval's notice and send it when they end, only if the change still waits", async () => {
    const chat = connectChat(freshChat());
    const t = setup({ quietUntil: 10 * 60_000 });
    const waiting = t.shown({ expiresAt: 30 * 60_000 });
    const answered = t.shown();
    t.events.emit("approval_shown", waiting);
    t.events.emit("approval_shown", answered);
    t.quiet.waiting.add(waiting.requestId);
    await t.queue.whenIdle();
    expect(texts(fake, chat)).toEqual([]);
    t.quiet.advance(10 * 60_000);
    await fake.waitFor(() => texts(fake, chat).length === 1);
    await t.queue.whenIdle();
    expect(texts(fake, chat)).toHaveLength(1);
    // The time left is counted when it is sent, not when it was held.
    expect(texts(fake, chat)[0]).toContain("Nothing runs unless you approve within 20 minutes.");
  });

  it("drop the reminder and the login notice", async () => {
    const chat = connectChat(freshChat());
    const t = setup({ quietUntil: 60 * 60_000 });
    t.events.emit("approval_reminder", t.shown());
    t.events.emit("login_needed", { sessionId: "chat-1", connectionId: 3, connectionName: "Prod <pg>" });
    await t.queue.whenIdle();
    expect(texts(fake, chat)).toEqual([]);
    expect(t.links).toEqual([]);
  });
});

describe("a connection that needs a login", () => {
  it("is a notice saying to log in from PPM, never asking for the password here", async () => {
    const chat = connectChat(freshChat());
    const t = setup({ chat: { project: "", providerId: null, title: "" } });
    t.events.emit("login_needed", { sessionId: "chat-7", connectionId: 3, connectionName: "Prod <pg>" });
    await fake.waitFor(() => texts(fake, chat).length === 1);
    await t.queue.whenIdle();
    const text = texts(fake, chat)[0]!;
    expect(text).toContain("A database needs you to log in");
    expect(text).toContain("Chat “Untitled chat” tried to use Prod <pg>, which asks for its password, and nobody has logged in to it since PPM started.");
    expect(text).toContain(LOGIN_IN_PPM);
    expect(allButtons(chat)).toEqual([]);
    expect(t.links).toEqual([{ project: "", provider: null, id: "chat-7" }]);
  });
});
