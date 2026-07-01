/**
 * PoC: host the interactive `claude` TUI inside a browser terminal (xterm.js) over a
 * PTY + WebSocket bridge. A HUMAN types in the browser → genuinely interactive use.
 *
 * Reuses the same PTY approach as src/services/terminal.service.ts (@skitee3000/bun-pty
 * on Windows). Standalone so you can test WITHOUT booting the whole PPM app.
 *
 * Goal of this test:
 *   1. UX — does the real Claude Code TUI feel good rendered in xterm.js? (token streaming, colors)
 *   2. Billing — after 2026-06-15, run a prompt here and check the Anthropic Console:
 *      does it draw from the interactive subscription or the Agent SDK credit pool?
 *
 * Run:   bun terminal-poc.ts
 * Open:  http://localhost:7878   (type into the terminal; `claude` auto-starts)
 */

const PORT = 7878;
const isWindows = process.platform === "win32";

interface Pty { write(d: string): void; resize(c: number, r: number): void; kill(): void; onData(cb: (s: string) => void): void; onExit(cb: () => void): void; }
const ptys = new Map<unknown, Pty>();

function spawnPty(cols: number, rows: number): Pty {
  if (isWindows) {
    // bun-pty FFI needs a short exe name (PATH-resolved), not a full path.
    const { spawn } = require("@skitee3000/bun-pty");
    return spawn("cmd.exe", [], { name: "xterm-256color", cols, rows, cwd: process.cwd(), env: process.env });
  }
  // macOS/Linux: Bun native PTY. Spawn a login shell and drive it the same way.
  const decoder = new TextDecoder();
  const dataCbs: Array<(s: string) => void> = [];
  const exitCbs: Array<() => void> = [];
  const proc = Bun.spawn([process.env.SHELL || "/bin/bash", "-l"], {
    cwd: process.cwd(),
    env: { ...process.env, TERM: "xterm-256color" },
    terminal: { cols, rows, data: (_t: any, d: Uint8Array) => dataCbs.forEach((cb) => cb(decoder.decode(d))) },
  });
  const term = (proc as any).terminal;
  proc.exited.then(() => exitCbs.forEach((cb) => cb()));
  return {
    write: (d) => term.write(d),
    resize: (c, r) => term.resize(c, r),
    kill: () => { try { term.close(); } catch {} try { proc.kill(); } catch {} },
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
  };
}

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<title>PPM terminal PoC — interactive claude</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<style>
  html,body{margin:0;height:100%;background:#0b0b0d;font-family:system-ui,sans-serif}
  #wrap{display:flex;flex-direction:column;height:100vh}
  #t{flex:1;min-height:0;padding:6px;box-sizing:border-box}
  #bar{display:flex;gap:6px;padding:8px;background:#15151a;border-top:1px solid #2a2a33}
  #in{flex:1;background:#0b0b0d;color:#e6e6e6;border:1px solid #333;border-radius:6px;padding:9px 11px;font-size:14px;outline:none}
  #in:focus{border-color:#5b8cff}
  #bar button{background:#2a2a33;color:#e6e6e6;border:1px solid #3a3a44;border-radius:6px;padding:0 12px;cursor:pointer}
  #bar button:hover{background:#3a3a44}
</style>
</head><body><div id="wrap"><div id="t"></div>
<div id="bar">
  <input id="in" placeholder="Gõ prompt rồi Enter (gửi cả dòng) — hoặc click vào terminal để gõ trực tiếp / phím mũi tên / y-n" autofocus>
  <button id="esc" title="Gửi Esc">Esc</button>
  <button id="ctrlc" title="Gửi Ctrl+C">^C</button>
</div></div>
<script>
  const term = new Terminal({ cursorBlink:true, fontFamily:"Cascadia Code, Consolas, monospace", fontSize:13, theme:{background:"#0b0b0d"} });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit);
  term.open(document.getElementById("t")); fit.fit();
  const ws = new WebSocket((location.protocol==="https:"?"wss":"ws")+"://"+location.host+"/ws");
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { send({type:"resize",cols:term.cols,rows:term.rows}); };
  ws.onmessage = (e) => { term.write(typeof e.data==="string"?e.data:new TextDecoder().decode(e.data)); };
  ws.onclose = () => term.write("\\r\\n[disconnected]\\r\\n");
  function send(o){ if(ws.readyState===1) ws.send(JSON.stringify(o)); }
  function input(d){ send({type:"input",data:d}); }
  // Direct typing into xterm still works (arrow keys, y/n dialogs, etc.)
  term.onData(d => input(d));
  // Convenient line input: type in the box, Enter sends the whole line + CR (no per-key lag).
  const box = document.getElementById("in");
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input(box.value + "\\r"); box.value=""; }
  });
  document.getElementById("ctrlc").onclick = () => { input("\\x03"); box.focus(); };
  document.getElementById("esc").onclick = () => { input("\\x1b"); box.focus(); };
  addEventListener("resize", () => { fit.fit(); send({type:"resize",cols:term.cols,rows:term.rows}); });
</script></body></html>`;

Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("upgrade failed", { status: 400 });
    }
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
  websocket: {
    open(ws) {
      const pty = spawnPty(80, 24);
      ptys.set(ws, pty);
      pty.onData((s) => { try { ws.send(s); } catch {} });
      pty.onExit(() => { try { ws.send("\r\n[process exited]\r\n"); ws.close(); } catch {} });
      // Auto-launch claude so opening the page drops you straight into the TUI.
      setTimeout(() => pty.write("claude\r"), 400);
      console.log("[poc] client connected → spawned pty (cmd → claude)");
    },
    message(ws, raw) {
      const pty = ptys.get(ws);
      if (!pty) return;
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === "input") pty.write(msg.data);
      else if (msg.type === "resize") pty.resize(msg.cols, msg.rows);
    },
    close(ws) {
      const pty = ptys.get(ws);
      if (pty) { try { pty.kill(); } catch {} ptys.delete(ws); }
      console.log("[poc] client disconnected → pty killed");
    },
  },
});

console.log(`[poc] open  http://localhost:${PORT}   (type into the terminal; \`claude\` auto-starts)`);
console.log(`[poc] platform=${process.platform}  Ctrl+C to stop`);
