/**
 * The Git Graph table has to stay a list of commits in a panel that is not wide.
 *
 * Repro this guards against: the graph column was set to whatever width the
 * lanes needed, with no relation to the panel. The message column was the only
 * one able to shrink, so in a repository with enough parallel branches the
 * graph took the row and every commit message was zero pixels wide — while the
 * columns behind it were clipped away with no way to scroll to them.
 *
 * This drives the real webview HTML in headless Chrome with a synthetic history
 * of 40 parallel branches, and measures the layout rather than reading the CSS.
 * The optional columns follow the list's own width (a container query), so the
 * inspector opening beside the list takes them away just as a narrower window does.
 *
 * Run:
 *   bun tests/e2e/git-graph-narrow-layout.ts
 *
 * Env:
 *   CHROME_PATH=...   override the Chrome executable path
 */

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { getWebviewHtml } from "../../packages/ext-git-graph/src/webview-html.ts";

const CDP_PORT = 9231;
const SHOTS = join(process.cwd(), "tests", "e2e", "screenshots");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

/** What the host normally provides. Nothing else about the page is altered. */
const HOST_STUB =
  "<script>window.acquireVsCodeApi = () => ({ postMessage: (m) => { (window.__posted = window.__posted || []).push(m); }, getState: () => undefined, setState: () => {} });</script>";

const BRANCHES = 40;
const TAIL = 5;
const hash = (i: number) => (i + 1).toString(16).padStart(40, "0");

/**
 * Forty branch heads whose common ancestor is the last commit, so forty lanes
 * are open at once — which is an ordinary week in a repository with a few
 * thousand branches, and the shape that used to leave the messages at zero.
 */
function syntheticHistory() {
  const commits = [];
  const base = BRANCHES + TAIL - 1;
  for (let i = 0; i < BRANCHES; i++) {
    commits.push({
      hash: hash(i),
      parents: [hash(base)],
      author: "Victor",
      authorEmail: "victor@example.com",
      authorDate: 1_780_000_000 - i * 3600,
      committer: "Victor",
      committerEmail: "victor@example.com",
      commitDate: 1_780_000_000 - i * 3600,
      refs: i < 6 ? [{ name: `origin/feat/NX-52${i}-a-fairly-long-branch-name`, type: "remote" }] : [],
      message: `feat(payroll): the subject of commit number ${i} that a reader has to be able to read`,
    });
  }
  for (let i = BRANCHES; i < BRANCHES + TAIL; i++) {
    commits.push({
      hash: hash(i),
      parents: i === base ? [] : [hash(i + 1)],
      author: "Hien Le",
      authorEmail: "hien@example.com",
      authorDate: 1_770_000_000 - i * 3600,
      committer: "Hien Le",
      committerEmail: "hien@example.com",
      commitDate: 1_770_000_000 - i * 3600,
      refs: [],
      message: `chore: trunk commit ${i}`,
    });
  }
  return commits;
}

let chrome: ReturnType<typeof spawn> | null = null;

async function launchChrome(): Promise<string> {
  const profile = join(tmpdir(), `ppm-git-graph-layout-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  await mkdir(SHOTS, { recursive: true });
  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--window-size=1200,900",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${CDP_PORT}/json`, { signal: AbortSignal.timeout(1500) });
      const page = (await r.json()).find((t: { type: string }) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* not ready */
    }
    await Bun.sleep(500);
  }
  throw new Error("Chrome DevTools endpoint never became ready");
}

class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(private ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data as string);
      const entry = msg.id && this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", () => rej(new Error("CDP ws error")), { once: true });
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 30_000);
    });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error("evaluate threw: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value as T;
  }

  async shot(name: string): Promise<void> {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    await writeFile(join(SHOTS, name), Buffer.from(data, "base64"));
  }
}

/** What the layout looks like right now, in pixels the browser actually used. */
const MEASURE = `(() => {
  const row = document.querySelector('#commit-list .commit-row');
  const cell = (c) => { const el = row.querySelector('.' + c); return el ? el.getBoundingClientRect() : null; };
  const clip = document.getElementById('graph-clip').getBoundingClientRect();
  const svg = document.querySelector('#graph-svg-container svg');
  const msg = cell('col-message');
  return {
    panel: document.documentElement.clientWidth,
    message: msg ? Math.round(msg.width) : 0,
    messageText: (row.querySelector('.msg-subject') || {}).textContent || '',
    messageVisible: msg ? Math.round(msg.right) <= document.documentElement.clientWidth : false,
    graphCell: Math.round(cell('col-graph').width),
    graphDrawn: svg ? Number(svg.getAttribute('width')) : 0,
    clipRight: Math.round(clip.right),
    messageLeft: msg ? Math.round(msg.left) : 0,
    list: document.getElementById('graph-container').clientWidth,
    shown: ['col-changes','col-author','col-date','col-hash']
      .filter((c) => { const el = row.querySelector('.' + c); return el && el.offsetParent !== null; }),
    // Below 760px of list the author is its avatar alone.
    author: cell('col-author') ? Math.round(cell('col-author').width) : 0,
    canPan: document.documentElement.classList.contains('graph-can-pan'),
    // Nothing may take a row between the header and the first commit: a
    // scrollbar of its own there is what this layout deliberately does without.
    headerBottom: Math.round(document.getElementById('graph-header').getBoundingClientRect().bottom),
    firstRowTop: Math.round(row.getBoundingClientRect().top),
    // The table's own overflow, not the document's: the settings panel is
    // parked off the right edge by a transform and sits in scrollWidth for the
    // whole life of the panel, so the document number answers a different
    // question. What matters here is whether a column was clipped away.
    overflow: (() => {
      const area = document.getElementById('graph-container');
      return Math.max(area.scrollWidth - area.clientWidth, 0);
    })(),
  };
})()`;

const failures: string[] = [];
function check(ok: boolean, what: string, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(what);
}

async function setWidth(cdp: Cdp, width: number): Promise<void> {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await Bun.sleep(250); // the resize observer re-caps the column
}

async function main(): Promise<void> {
  const file = join(tmpdir(), `git-graph-${Date.now()}.html`);
  await writeFile(file, getWebviewHtml().replace("<head>", "<head>" + HOST_STUB), "utf8");

  const wsUrl = await launchChrome();
  const cdp = await Cdp.connect(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: pathToFileURL(file).href });
  await Bun.sleep(1200);

  await cdp.evaluate(
    `window.postMessage({ command: 'loadCommits', data: ${JSON.stringify(syntheticHistory())} }, '*')`,
  );
  await Bun.sleep(400);

  console.log(`\nA history of ${BRANCHES} parallel branches.\n`);

  // --- Desktop panel, the width from the bug report ---
  await setWidth(cdp, 1020);
  let m = await cdp.evaluate<any>(MEASURE);
  console.log(`1020px — message ${m.message}px, graph cell ${m.graphCell}px of ${m.graphDrawn}px drawn, columns: ${m.shown.join(", ")}`);
  await cdp.shot("git-graph-1020.png");
  check(m.graphDrawn > m.graphCell, "the graph really is wider than its column", `${m.graphDrawn} > ${m.graphCell}`);
  check(m.message >= 240, "the message column keeps its floor", `${m.message}px`);
  check(m.messageText.length > 0 && m.messageVisible, "the subject is on screen", JSON.stringify(m.messageText.slice(0, 40)));
  check(m.clipRight <= m.messageLeft, "the overlay is clipped before the message starts", `${m.clipRight} <= ${m.messageLeft}`);
  check(m.canPan, "the graph reports that it can be panned");
  check(m.overflow <= 0, "nothing is clipped off the right edge", `overflow ${m.overflow}px`);

  check(
    m.firstRowTop === m.headerBottom,
    "nothing takes a row between the header and the first commit",
    `header ends ${m.headerBottom}, first row ${m.firstRowTop}`,
  );

  // --- Panning by dragging the graph itself ---
  const at = await cdp.evaluate<any>(`(() => {
    const cell = document.querySelectorAll('#commit-list .commit-row')[4].querySelector('.col-graph');
    const r = cell.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  const hit = await cdp.evaluate<string>(`(() => {
    const el = document.elementFromPoint(${at.x}, ${at.y});
    if (!el) return 'none';
    const parent = el.parentElement;
    return el.tagName + '[' + (el.getAttribute('class') || '') + '] in ' + (parent ? parent.id || parent.className : '?');
  })()`);
  console.log(`  (drag starts on ${hit})`);
  const overlayLeft = () =>
    cdp.evaluate<number>("Math.round(document.querySelector('#graph-svg-container').getBoundingClientRect().left)");
  const beforeDrag = await overlayLeft();
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", buttons: 1, clickCount: 1 });
  for (const step of [30, 70, 110, 150]) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x - step, y: at.y, button: "left", buttons: 1 });
  }
  const midDrag = await cdp.evaluate<any>(`({
    hint: document.getElementById('graph-pan-bar').classList.contains('visible'),
    thumb: document.getElementById('graph-pan-thumb').style.width,
    grabbing: document.documentElement.classList.contains('graph-panning'),
  })`);
  await cdp.shot("git-graph-panning.png");
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x - 150, y: at.y, button: "left", buttons: 0, clickCount: 1 });
  await Bun.sleep(150);
  const afterDrag = await overlayLeft();
  const selected = await cdp.evaluate<number>("document.querySelectorAll('.commit-row.selected').length");
  check(afterDrag < beforeDrag, "dragging the graph pans it", `${beforeDrag} -> ${afterDrag}`);
  check(midDrag.hint && midDrag.grabbing, "a hint shows while the drag is happening", `thumb ${midDrag.thumb}`);
  check(selected === 0, "the drag did not select the commit it ended on", `${selected} selected`);

  // A press that does not move is still the click that opens a commit.
  await cdp.evaluate("closeDetailPanel()");
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", buttons: 0, clickCount: 1 });
  await Bun.sleep(200);
  check(
    (await cdp.evaluate<number>("document.querySelectorAll('.commit-row.selected').length")) === 1,
    "a press without a drag still opens the commit",
  );
  await cdp.evaluate("closeDetailPanel()");

  // --- A split pane, and a tablet in portrait ---
  for (const width of [900, 760, 700]) {
    await setWidth(cdp, width);
    m = await cdp.evaluate<any>(MEASURE);
    console.log(`${width}px — message ${m.message}px, graph cell ${m.graphCell}px, columns: ${m.shown.join(", ") || "(none)"}`);
    check(m.message >= 240, `${width}px keeps the message readable`, `${m.message}px`);
    check(m.overflow <= 0, `${width}px clips nothing off the edge`, `overflow ${m.overflow}px`);
    check(!m.shown.includes("col-hash") && m.shown.includes("col-date"), `${width}px has dropped the hash and kept the date`);
    if (width <= 760) check(m.author > 0 && m.author <= 24, `${width}px keeps only the author's avatar`, `${m.author}px`);
  }
  await cdp.shot("git-graph-760.png");

  // --- The inspector open beside the list: the list's width decides, not the window's ---
  await setWidth(cdp, 1020);
  await cdp.evaluate(`selectCommit(${JSON.stringify(hash(2))})`);
  await Bun.sleep(250);
  for (const width of [1020, 960]) {
    await setWidth(cdp, width);
    m = await cdp.evaluate<any>(MEASURE);
    console.log(`${width}px with the inspector — list ${m.list}px, message ${m.message}px, columns: ${m.shown.join(", ") || "(none)"}`);
    check(m.list <= 640, `${width}px with the inspector leaves the list narrower than the window`, `${m.list}px`);
    check(m.message >= 240, `${width}px with the inspector keeps the message readable`, `${m.message}px`);
    check(m.overflow <= 0, `${width}px with the inspector clips nothing off the edge`, `overflow ${m.overflow}px`);
    check(!m.shown.includes("col-hash"), `${width}px with the inspector has dropped the hash`);
    check(m.shown.includes("col-changes") === m.list > 600, `${width}px with the inspector shows changes only above 600px of list`);
  }
  await cdp.shot("git-graph-inspector-960.png");
  await cdp.evaluate("closeDetailPanel()");

  // --- Phone ---
  await setWidth(cdp, 390);
  m = await cdp.evaluate<any>(MEASURE);
  console.log(`390px — message ${m.message}px, columns: ${m.shown.join(", ") || "(none)"}`);
  await cdp.shot("git-graph-390.png");
  check(m.overflow <= 0, "the phone layout does not overflow sideways", `overflow ${m.overflow}px`);
  check(m.message > 200, "the phone row is mostly the message", `${m.message}px`);
  check(m.shown.length === 0, "the phone row has no columns beside the message", m.shown.join(", "));
  // The phone's second line names the branch: one ref, with its name.
  const pill = await cdp.evaluate<any>(`(() => {
    const ref = document.querySelector('#commit-list .commit-row .refs .ref');
    const name = ref && ref.querySelector('span:not(.ahead)');
    return { refs: document.querySelectorAll('#commit-list .commit-row:first-child .refs .ref').length,
      shown: Array.from(document.querySelectorAll('#commit-list .commit-row:first-child .refs .ref')).filter((r) => r.offsetParent !== null).length,
      name: name ? Math.round(name.getBoundingClientRect().width) : 0 };
  })()`);
  check(pill.shown === 1 && pill.name > 0, "the phone row shows its first ref with the ref's name", `${pill.shown} shown, name ${pill.name}px`);

  // --- The header's own menu ---
  await setWidth(cdp, 700);
  const menu = await cdp.evaluate<any>(`(() => {
    document.getElementById('graph-header').dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }));
    const items = Array.from(document.querySelectorAll('#context-menu .mi'));
    return {
      hidden: document.getElementById('context-menu').classList.contains('hidden'),
      labels: items.map((el) => el.textContent.trim()),
      ticked: items.filter((el) => el.getAttribute('aria-checked') === 'true').length,
      disabled: items.filter((el) => el.disabled).map((el) => el.textContent.trim()),
    };
  })()`);
  check(!menu.hidden && menu.labels.length === 4, "right-clicking the header offers every column", menu.labels.join(" / "));
  check(menu.ticked === 4, "each column that is on is ticked", `${menu.ticked} ticked`);
  check(
    menu.disabled.length === 1 && menu.disabled[0]!.startsWith("Hash") && menu.disabled[0]!.includes("needs a wider panel"),
    "the one this width has taken away says so",
    menu.disabled.join(" / "),
  );
  await cdp.shot("git-graph-column-menu.png");
  await cdp.evaluate("closeMenu()");

  // --- A column the reader turned off gives its width to the graph ---
  await setWidth(cdp, 1020);
  const freed = await cdp.evaluate<any>(`(() => {
    const before = document.querySelector('.commit-row .col-graph').getBoundingClientRect().width;
    setColumnVisible('colAuthor', false);
    return new Promise((r) => setTimeout(() => r({
      before: Math.round(before),
      after: Math.round(document.querySelector('.commit-row .col-graph').getBoundingClientRect().width),
      clip: Math.round(document.getElementById('graph-clip').getBoundingClientRect().width),
      overlayLeft: Math.round(document.getElementById('graph-clip').getBoundingClientRect().left),
    }), 150));
  })()`);
  check(freed.after > freed.before, "hiding a column widens the graph", `${freed.before} -> ${freed.after}`);
  check(Math.abs(freed.clip - freed.after) <= 1, "the overlay's clip follows the wider column", `clip ${freed.clip}, column ${freed.after}`);
  check(freed.overlayLeft <= 12, "the graph starts at the left edge", `${freed.overlayLeft}px`);
  await cdp.evaluate("setColumnVisible('colAuthor', true)");

  console.log(`\nScreenshots in ${SHOTS}\n`);
  if (failures.length) {
    console.error(`${failures.length} check(s) failed:\n - ${failures.join("\n - ")}`);
    process.exitCode = 1;
  } else {
    console.log("All checks passed.");
  }
}

try {
  await main();
} finally {
  chrome?.kill();
}
