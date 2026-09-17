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
  const strip = document.getElementById('graph-hscroll');
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
    shown: ['col-refs','col-changes','col-author','col-date','col-hash']
      .filter((c) => { const el = row.querySelector('.' + c); return el && el.offsetParent !== null; }),
    stripHidden: strip.classList.contains('hidden'),
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
  check(!m.stripHidden, "the header offers a scrollbar for the rest of the graph");
  check(m.overflow <= 0, "nothing is clipped off the right edge", `overflow ${m.overflow}px`);

  // --- Panning the graph ---
  const pan = await cdp.evaluate<any>(`(() => {
    const strip = document.getElementById('graph-hscroll');
    const before = document.querySelector('#graph-svg-container').getBoundingClientRect().left;
    strip.scrollLeft = 150;
    return new Promise((r) => setTimeout(() => r({
      before: Math.round(before),
      after: Math.round(document.querySelector('#graph-svg-container').getBoundingClientRect().left),
      pan: getComputedStyle(document.documentElement).getPropertyValue('--graph-pan-x').trim(),
    }), 120));
  })()`);
  check(pan.after < pan.before, "the strip pans the graph", `${pan.before} -> ${pan.after} (${pan.pan})`);

  // --- A split pane, and a tablet in portrait ---
  for (const width of [900, 760, 700]) {
    await setWidth(cdp, width);
    m = await cdp.evaluate<any>(MEASURE);
    console.log(`${width}px — message ${m.message}px, graph cell ${m.graphCell}px, columns: ${m.shown.join(", ") || "(none)"}`);
    check(m.message >= 240, `${width}px keeps the message readable`, `${m.message}px`);
    check(m.overflow <= 0, `${width}px clips nothing off the edge`, `overflow ${m.overflow}px`);
    check(!m.shown.includes("col-date") && !m.shown.includes("col-hash"), `${width}px has dropped date and hash`);
  }
  await cdp.shot("git-graph-760.png");
  check(!(await cdp.evaluate<any>(MEASURE)).shown.includes("col-changes"), "700px has dropped changes as well");

  // --- Phone ---
  await setWidth(cdp, 390);
  m = await cdp.evaluate<any>(MEASURE);
  console.log(`390px — message ${m.message}px, columns: ${m.shown.join(", ") || "(none)"}`);
  await cdp.shot("git-graph-390.png");
  check(m.overflow <= 0, "the phone layout does not overflow sideways", `overflow ${m.overflow}px`);
  check(m.message > 200, "the phone row is mostly the message", `${m.message}px`);

  // --- The header's own menu ---
  await setWidth(cdp, 700);
  const menu = await cdp.evaluate<any>(`(() => {
    document.getElementById('graph-header').dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }));
    const items = Array.from(document.querySelectorAll('#context-menu .ctx-item'));
    return {
      hidden: document.getElementById('context-menu').classList.contains('hidden'),
      labels: items.map((el) => el.textContent.trim()),
      ticked: items.filter((el) => (el.querySelector('.ctx-tick') || {}).textContent).length,
      disabled: items.filter((el) => el.classList.contains('disabled')).map((el) => el.textContent.trim()),
    };
  })()`);
  check(!menu.hidden && menu.labels.length === 5, "right-clicking the header offers every column", menu.labels.join(" / "));
  check(menu.ticked === 5, "each column that is on is ticked", `${menu.ticked} ticked`);
  check(
    menu.disabled.length === 3 && menu.disabled.every((l: string) => l.includes("needs a wider panel")),
    "the ones this width has taken away say so",
    menu.disabled.join(" / "),
  );
  await cdp.shot("git-graph-column-menu.png");

  // --- A column the reader turned off gives its width to the graph ---
  await setWidth(cdp, 1020);
  const freed = await cdp.evaluate<any>(`(() => {
    const before = document.querySelector('.commit-row .col-graph').getBoundingClientRect().width;
    setColumnVisible('colRefs', false);
    return new Promise((r) => setTimeout(() => r({
      before: Math.round(before),
      after: Math.round(document.querySelector('.commit-row .col-graph').getBoundingClientRect().width),
      refsVar: getComputedStyle(document.documentElement).getPropertyValue('--refs-col-w').trim(),
      overlayLeft: Math.round(document.getElementById('graph-clip').getBoundingClientRect().left),
    }), 150));
  })()`);
  check(freed.after > freed.before, "hiding a column widens the graph", `${freed.before} -> ${freed.after}`);
  check(freed.refsVar === "0px", "the overlay's origin follows the hidden column", `--refs-col-w: ${freed.refsVar}`);
  check(freed.overlayLeft <= 12, "the graph starts at the left edge now", `${freed.overlayLeft}px`);

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
