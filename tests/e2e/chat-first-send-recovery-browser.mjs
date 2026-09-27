// Start chat-first-send-recovery.ts, then run this with Bun. Uses a fresh,
// isolated Chrome profile and closes only the browser it starts.
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const profile = await mkdtemp(join(tmpdir(), "ppm-draft-browser-"));
const chrome = spawn(process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--remote-debugging-port=9228", `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--window-size=1280,900", "about:blank",
], { windowsHide: true, stdio: "ignore" });
let socket;
const pending = new Map();
let nextId = 0;
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function until(expression) {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(expression)) return;
    await Bun.sleep(100);
  }
  const state = await evaluate("JSON.stringify({recovery:window.recovery, text:document.body.innerText, inputs:Array.from(document.querySelectorAll('textarea')).map(t=>({value:t.value,disabled:t.disabled})), storage:Object.keys(sessionStorage)})");
  throw new Error(`Condition failed: ${expression}\n${state}\nErrors: ${errors.join('; ')}`);
}
const visibleInput = `Array.from(document.querySelectorAll('textarea')).find(t => t.offsetParent !== null)`;
async function navigate(url) {
  const previous = await evaluate("window.recovery?.loadId ?? null");
  await send(url ? "Page.navigate" : "Page.reload", url ? { url } : {});
  await until(`!!window.recovery?.loadId && window.recovery.loadId !== ${JSON.stringify(previous)} && !!(${visibleInput})`);
}
const errors = [];
try {
  let pages;
  for (let i = 0; i < 100; i++) {
    try { pages = await (await fetch("http://127.0.0.1:9228/json")).json(); break; } catch { await Bun.sleep(100); }
  }
  socket = new WebSocket(pages.find(p => p.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = ({ data }) => {
    const event = JSON.parse(data);
    if (event.method === "Runtime.exceptionThrown") errors.push(event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text);
    const waiter = pending.get(event.id);
    if (!waiter) return;
    pending.delete(event.id); clearTimeout(waiter.timer);
    event.error ? waiter.reject(new Error(event.error.message)) : waiter.resolve(event.result);
  };
  await send("Runtime.enable");
  await send("Page.enable");
  for (const mode of ["stall", "no-ws"]) {
    await navigate(`http://127.0.0.1:5189/?mode=${mode}`);
    await until(`!!(${visibleInput})`);
    await evaluate("sessionStorage.clear()");
    await navigate();
    await until(`!!(${visibleInput})`);
    await evaluate(`(${visibleInput}).focus()`);
    await send("Input.insertText", { text: `Recover ${mode} draft` });
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await until("document.body.innerText.includes('Starting conversation')");
    // The fixture records the server-created id before the response reaches
    // React. Wait for the client to adopt it before testing reload at this stage.
    if (mode === "no-ws") await until("Object.keys(sessionStorage).some(k => k.startsWith('ppm-chat-draft:') && k.includes('recovery-session'))");
    await navigate();
    await until(`(${visibleInput})?.value === ${JSON.stringify(`Recover ${mode} draft`)}`);
    if (await evaluate("window.recovery.posts !== 0 || window.recovery.messages !== 0")) throw new Error("Automatically resent on recovery");
    console.log(`PASS ${mode}: reload restored text without sending`);
    const shot = await send("Page.captureScreenshot", { format: "png" });
    const path = join(profile, `${mode}-recovered.png`);
    await Bun.write(path, Buffer.from(shot.data, "base64"));
    console.log(`Screenshot: ${path}`);
    await navigate("http://127.0.0.1:5189/?mode=success");
    await until(`!!(${visibleInput}) && !(${visibleInput}).disabled`);
    await evaluate(`(${visibleInput}).focus()`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await until("window.recovery.messages === 1");
    if (await evaluate("Object.keys(sessionStorage).some(k => k.startsWith('ppm-chat-draft:'))")) throw new Error("Sent draft was not cleared");
    console.log(`PASS ${mode}: explicit resend sent once and cleared draft`);
  }
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  console.log("PASS browser console: no uncaught errors");
} finally {
  if (socket?.readyState === 1) await send("Browser.close").catch(() => {});
  socket?.close();
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  if (chrome.exitCode === null) chrome.kill();
}
