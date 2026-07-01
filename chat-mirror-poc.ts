/**
 * PoC (hybrid): drive an interactive `claude` via PTY, but render its output as a
 * STRUCTURED chat UI (bubbles / markdown / tool cards) by tailing the session JSONL —
 * instead of showing the raw ANSI terminal.
 *
 *   input box ──► write "prompt\r" to PTY ──► claude (interactive → interactive billing)
 *   claude writes JSONL ──► tail ──► parse to events ──► WS ──► chat bubbles
 *
 * This mirrors the idea behind PPM's jsonl-transcript-parser.ts (parseSessionMessage →
 * ChatEvent[]). Here the parser is inlined + minimal so the demo is standalone.
 *
 * Trade-off vs raw terminal: clean PPM-like UI, BUT block-level granularity (no
 * token-by-token streaming) and tool approvals happen inside claude (not interceptable).
 *
 * Run:  bun chat-mirror-poc.ts   →  open http://localhost:7878
 */

import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { existsSync, statSync, readdirSync, openSync, readSync, closeSync } from "node:fs";

const PORT = 7878;
const PROJECTS_DIR = resolve(homedir(), ".claude/projects");
// Run claude in an ALREADY-TRUSTED dir (the PPM repo) to avoid the first-run
// "trust this folder?" dialog that blocks a fresh temp cwd.
const POC_CWD = process.cwd();

// ── PTY (bun-pty on Windows, Bun native otherwise) ──
interface Pty { write(d: string): void; kill(): void; onData(cb: (s: string) => void): void; onExit(cb: () => void): void; }
function spawnPty(): Pty {
  if (process.platform === "win32") {
    const { spawn } = require("@skitee3000/bun-pty");
    const pty = spawn("cmd.exe", [], { name: "xterm-256color", cols: 100, rows: 30, cwd: POC_CWD, env: process.env });
    return { write: (d) => pty.write(d), kill: () => { try { pty.kill(); } catch {} }, onData: (cb) => pty.onData(cb), onExit: (cb) => pty.onExit(cb) };
  }
  const dec = new TextDecoder(); const dcb: Array<(s: string) => void> = []; const ecb: Array<() => void> = [];
  const proc = Bun.spawn([process.env.SHELL || "/bin/bash", "-l"], { cwd: POC_CWD, env: { ...process.env, TERM: "xterm-256color" }, terminal: { cols: 100, rows: 30, data: (_t: any, d: Uint8Array) => dcb.forEach((cb) => cb(dec.decode(d))) } });
  const term = (proc as any).terminal; proc.exited.then(() => ecb.forEach((cb) => cb()));
  return { write: (d) => term.write(d), kill: () => { try { term.close(); proc.kill(); } catch {} }, onData: (cb) => dcb.push(cb), onExit: (cb) => ecb.push(cb) };
}

// ── JSONL discovery + tail ──
function readFrom(path: string, from: number, to: number): string {
  const fd = openSync(path, "r");
  try { const buf = Buffer.allocUnsafe(to - from); const n = readSync(fd, buf, 0, to - from, from); return buf.subarray(0, n).toString("utf8"); }
  finally { closeSync(fd); }
}
function allJsonl(): string[] {
  if (!existsSync(PROJECTS_DIR)) return [];
  const out: string[] = [];
  for (const d of readdirSync(PROJECTS_DIR)) {
    const full = join(PROJECTS_DIR, d);
    try { for (const f of readdirSync(full)) if (f.endsWith(".jsonl")) out.push(join(full, f)); } catch {}
  }
  return out;
}

/** Parse one JSONL line → chat events (role/kind/payload). Mirrors parseSessionMessage shape, minimal. */
function eventsFromLine(line: string): any[] {
  let o: any; try { o = JSON.parse(line); } catch { return []; }
  const out: any[] = [];
  const c = o?.message?.content;
  if (o.type === "assistant" && Array.isArray(c)) {
    for (const b of c) {
      if (b.type === "text" && b.text?.trim()) out.push({ role: "assistant", kind: "text", text: b.text });
      else if (b.type === "thinking" && b.thinking?.trim()) out.push({ role: "assistant", kind: "thinking", text: b.thinking });
      else if (b.type === "tool_use") out.push({ role: "assistant", kind: "tool_use", name: b.name, input: b.input });
    }
  } else if (o.type === "user") {
    if (typeof c === "string" && c.trim()) out.push({ role: "user", kind: "text", text: c });
    else if (Array.isArray(c)) for (const b of c) {
      if (b.type === "text" && b.text?.trim()) out.push({ role: "user", kind: "text", text: b.text });
      else if (b.type === "tool_result") { const x = b.content ?? b.output ?? ""; out.push({ role: "tool", kind: "tool_result", output: typeof x === "string" ? x : JSON.stringify(x) }); }
    }
  }
  return out;
}

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>PPM chat-mirror PoC</title>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<style>
 :root{color-scheme:dark} *{box-sizing:border-box}
 html,body{margin:0;height:100%;background:#0b0b0d;color:#e6e6e6;font-family:system-ui,sans-serif}
 #wrap{display:flex;flex-direction:column;height:100vh;max-width:820px;margin:0 auto}
 #log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
 .msg{padding:10px 14px;border-radius:12px;max-width:85%;line-height:1.5;font-size:14px;white-space:normal}
 .msg p{margin:.3em 0} .msg pre{background:#000;padding:8px;border-radius:6px;overflow-x:auto}
 .user{align-self:flex-end;background:#234;border:1px solid #356}
 .assistant{align-self:flex-start;background:#16161c;border:1px solid #2a2a33}
 .thinking{align-self:flex-start;background:transparent;border:1px dashed #333;color:#888;font-size:12px;font-style:italic;max-width:85%}
 .tool_use{align-self:flex-start;background:#1a1410;border:1px solid #4a3a20;color:#e0b070;font-family:monospace;font-size:12px}
 .tool_result{align-self:flex-start;background:#101a10;border:1px solid #244;color:#9c9;font-family:monospace;font-size:12px;max-width:85%}
 #bar{display:flex;gap:8px;padding:12px;background:#15151a;border-top:1px solid #2a2a33}
 #in{flex:1;background:#0b0b0d;color:#e6e6e6;border:1px solid #333;border-radius:8px;padding:11px 13px;font-size:14px;outline:none}
 #in:focus{border-color:#5b8cff} #send{background:#2f6;border:none;border-radius:8px;padding:0 18px;font-weight:600;cursor:pointer}
 .label{font-size:10px;text-transform:uppercase;opacity:.5;margin-bottom:3px}
</style></head><body><div id="wrap">
<div id="log"></div>
<div id="bar"><input id="in" placeholder="Nhập prompt rồi Enter…" autofocus><button id="send">Gửi</button></div>
</div><script>
 const log=document.getElementById("log"), box=document.getElementById("in");
 const ws=new WebSocket((location.protocol==="https:"?"wss":"ws")+"://"+location.host+"/ws");
 ws.onmessage=(e)=>{ const m=JSON.parse(e.data); if(m.kind==="event") render(m.ev); };
 function add(cls,html){ const d=document.createElement("div"); d.className="msg "+cls; d.innerHTML=html; log.appendChild(d); log.scrollTop=log.scrollHeight; }
 function render(ev){
   if(ev.kind==="text") add(ev.role, (ev.role==="user"?"<div class='label'>you</div>":"")+marked.parse(ev.text));
   else if(ev.kind==="thinking") add("thinking","💭 "+ev.text.slice(0,400));
   else if(ev.kind==="tool_use") add("tool_use","🔧 "+ev.name+"  "+escapeHtml(JSON.stringify(ev.input||{}).slice(0,200)));
   else if(ev.kind==="tool_result") add("tool_result","↳ "+escapeHtml(ev.output.slice(0,400)));
 }
 function escapeHtml(s){ return s.replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
 function send(){ const v=box.value.trim(); if(!v)return; ws.send(JSON.stringify({type:"input",data:v})); box.value=""; }
 box.addEventListener("keydown",e=>{ if(e.key==="Enter"){e.preventDefault();send();} });
 document.getElementById("send").onclick=send;
</script></body></html>`;

interface Conn { pty: Pty; target: string | null; offset: number; carry: string; before: Set<string>; timer: any; }
const conns = new Map<unknown, Conn>();

Bun.serve({
  port: PORT,
  fetch(req, server) {
    if (new URL(req.url).pathname === "/ws") { if (server.upgrade(req)) return; return new Response("upgrade failed", { status: 400 }); }
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
  websocket: {
    open(ws) {
      const before = new Set(allJsonl());
      const pty = spawnPty();
      const conn: Conn = { pty, target: null, offset: 0, carry: "", before, timer: null };
      conns.set(ws, conn);
      pty.onExit(() => { try { ws.close(); } catch {} });
      pty.onData((s) => { const t = s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trim(); if (t) console.log("[pty]", t.slice(0, 200)); }); // debug: see what claude shows
      setTimeout(() => pty.write("claude\r"), 600); // auto-launch interactive claude
      // Poll: find the new JSONL, then tail it → parse → push events.
      conn.timer = setInterval(() => {
        if (!conn.target) {
          const fresh = allJsonl().filter((p) => !conn.before.has(p));
          if (fresh.length) { conn.target = fresh.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]; conn.offset = 0; }
          else return;
        }
        let size: number; try { size = statSync(conn.target).size; } catch { return; }
        if (size <= conn.offset) return;
        const chunk = conn.carry + readFrom(conn.target, conn.offset, size);
        conn.offset = size;
        const lines = chunk.split("\n"); conn.carry = lines.pop() ?? "";
        for (const ln of lines) if (ln.trim()) for (const ev of eventsFromLine(ln)) {
          try { ws.send(JSON.stringify({ kind: "event", ev })); } catch {}
        }
      }, 200);
      console.log("[poc] client connected → claude spawned, watching JSONL");
    },
    message(ws, raw) {
      const conn = conns.get(ws); if (!conn) return;
      let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === "input") conn.pty.write(m.data + "\r");
    },
    close(ws) {
      const conn = conns.get(ws); if (!conn) return;
      clearInterval(conn.timer); try { conn.pty.kill(); } catch {} conns.delete(ws);
      console.log("[poc] client disconnected");
    },
  },
});
console.log(`[poc] chat-mirror on http://localhost:${PORT}  (cwd=${POC_CWD})`);
