// The pinned card desk on Telegram, end to end, drawn as a phone: runs
// `fixtures/telegram-card-desk-scenario.ts` (the real bridge against the fake Bot API: three chats
// waiting on approvals, Allow pressed on the desk, a number pressed, a reminder under the desk,
// /cards, everything answered) and draws each snapshot of the phone's chat as a 390×844 Telegram
// screen — the messages exactly as the bot sent them, their buttons, the pinned bar.
//
//   PPM_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node tests/e2e/telegram-card-desk-e2e.mjs
//
// PPM_PLAYWRIGHT_CHANNEL=chrome runs the installed Chrome; PPM_CARD_DESK_SHOTS is where the PNGs go
// (default: a temp folder). Needs Bun on PATH (or PPM_BUN). Nothing real is touched: no Telegram,
// no model, no PPM data.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const shotsDir = resolve(process.env.PPM_CARD_DESK_SHOTS ?? mkdtempSync(join(tmpdir(), "ppm-card-desk-shots-")));
mkdirSync(shotsDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "ppm-card-desk-e2e-"));
const json = join(work, "snapshots.json");

const bun = process.env.PPM_BUN ?? "bun";
const run = spawnSync(bun, ["tests/e2e/fixtures/telegram-card-desk-scenario.ts", json], { stdio: "inherit", env: process.env });
const data = JSON.parse(readFileSync(json, "utf8"));
if (run.status !== 0 || data.error) {
  console.error(`scenario failed: ${data.error ?? `exit ${run.status}`}`);
  process.exit(1);
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { width: 390px; height: 844px; font: 14.5px/1.35 -apple-system, "Segoe UI", Roboto, sans-serif; overflow: hidden; background: #fff; }
.phone { width: 390px; height: 844px; display: flex; flex-direction: column; }
.top { height: 56px; display: flex; align-items: center; gap: 10px; padding: 0 12px; border-bottom: 1px solid #e5e5e5; }
.ava { width: 38px; height: 38px; border-radius: 50%; background: linear-gradient(135deg,#6c8cff,#3f5bd8); color: #fff; display: grid; place-items: center; font-weight: 700; }
.who b { display: block; font-size: 16px; } .who span { font-size: 13px; color: #8a8a8a; }
.pin { display: flex; gap: 10px; padding: 6px 12px; border-bottom: 1px solid #e5e5e5; }
.pin .bar { width: 2px; background: #2481cc; border-radius: 2px; }
.pin .t { color: #2481cc; font-size: 12.5px; font-weight: 600; } .pin .s { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 330px; }
.cap { background: #fff8e1; color: #6b4e00; font-size: 12.5px; padding: 5px 12px; border-bottom: 1px solid #f0e2b0; }
.chat { flex: 1; overflow: hidden; display: flex; flex-direction: column; justify-content: flex-end; gap: 6px; padding: 8px; background: #cfe3c0; }
.msg { max-width: 350px; }
.bubble { background: #fff; border-radius: 14px 14px 14px 4px; padding: 6px 10px; box-shadow: 0 1px 1px rgba(0,0,0,.12); white-space: pre-wrap; word-break: break-word; }
.bubble pre { font: 12px Consolas, monospace; background: #f1f4f8; border-left: 3px solid #2481cc; padding: 4px 6px; border-radius: 4px; white-space: pre-wrap; }
.bubble code { font: 12.5px Consolas, monospace; background: #f1f1f1; padding: 0 3px; border-radius: 3px; }
.bubble a { color: #2481cc; text-decoration: none; }
.meta { float: right; font-size: 11px; color: #8a9a8a; margin: 4px 0 0 8px; }
.quote { border-left: 3px solid #2481cc; background: #eaf3fc; border-radius: 4px; padding: 2px 6px; margin-bottom: 4px; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kb { display: grid; gap: 4px; margin-top: 4px; } .kb .r { display: flex; gap: 4px; }
.kb .k { flex: 1; background: rgba(60,90,60,.38); color: #fff; font-size: 13px; font-weight: 600; text-align: center; padding: 7px 4px; border-radius: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.svc { align-self: center; background: rgba(0,0,0,.2); color: #fff; font-size: 12px; padding: 2px 9px; border-radius: 10px; }
.input { height: 48px; border-top: 1px solid #e5e5e5; display: flex; align-items: center; padding: 0 14px; color: #9a9a9a; }`;

function page(shot) {
  const byId = new Map(shot.messages.map((m) => [m.id, m]));
  const pinned = shot.pins.length ? byId.get(shot.pins.at(-1)) : null;
  const firstLine = (m) => (m?.text ?? "").split("\n")[0];
  const items = [];
  for (const m of shot.messages) {
    const quote = m.replyTo && byId.get(m.replyTo) ? `<div class="quote">↪ ${esc(firstLine(byId.get(m.replyTo)))}</div>` : "";
    const kb = m.buttons.length
      ? `<div class="kb">${m.buttons.map((r) => `<div class="r">${r.map((b) => `<div class="k">${esc(b.text)}${b.url ? " ↗" : ""}</div>`).join("")}</div>`).join("")}</div>`
      : "";
    items.push(`<div class="msg"><div class="bubble">${quote}${m.html ?? esc(m.text)}<span class="meta">${m.silent ? "🔕" : "🔔"}</span></div>${kb}</div>`);
    if (shot.pins.includes(m.id)) items.push(`<div class="svc">PPM Assistant pinned a message</div>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body><div class="phone">
<div class="top"><div class="ava">P</div><div class="who"><b>PPM Assistant</b><span>bot · fake Telegram</span></div></div>
${pinned ? `<div class="pin"><div class="bar"></div><div><div class="t">Pinned message</div><div class="s">${esc(firstLine(pinned))}</div></div></div>` : ""}
<div class="cap">${esc(shot.caption)}</div>
<div class="chat">${items.join("\n")}</div>
<div class="input">Message</div></div></body></html>`;
}

const { chromium } = await import(pathToFileURL(process.env.PPM_PLAYWRIGHT_MODULE).href);
const channel = process.env.PPM_PLAYWRIGHT_CHANNEL;
const browser = await chromium.launch({ ...(channel ? { channel } : {}), ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}) });
try {
  const tab = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  for (const shot of data.shots) {
    const file = join(work, `${shot.name}.html`);
    writeFileSync(file, page(shot));
    await tab.goto(pathToFileURL(file).href);
    await tab.screenshot({ path: join(shotsDir, `${shot.name}.png`) });
    console.log(`shot: ${join(shotsDir, `${shot.name}.png`)}`);
  }
} finally {
  await browser.close();
}
console.log(`ok: ${data.shots.length} screens`);
