// The session changes bar and the block-by-block Review tab, on the production Vite bundle
// against a disposable API/ws server whose only provider is scripted
// (tests/e2e/fixtures/session-changes-server.ts): it really writes the project's files over
// two turns, taking each file's "before" first the way the Claude provider's PreToolUse hook
// does, and runs a shell command between the hooks that bracket one. Then keeps and reverts
// blocks with the keyboard and the buttons, undoes answers, reverts whole files, follows a third
// turn live, and checks every answer on disk and after a reload. No live credentials, no real
// PPM data.
//
//   PPM_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs bun tests/e2e/session-changes-e2e.mjs
//
// PPM_CHANGES_WEB_DIR=<dir> reuses an existing scratch build (with Monaco staged under
// assets/monaco/vs) instead of building one; PPM_CHANGES_ONLY=desktop-review,mobile-review,
// desktop-tray,mobile-tray picks scenarios.
import { spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import assert from "node:assert/strict";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-changes-e2e-"));
const artifacts = process.env.PPM_CHANGES_ARTIFACTS ? resolve(process.env.PPM_CHANGES_ARTIFACTS) : join(sandbox, "artifacts");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), projects = join(sandbox, "projects");
await Promise.all([artifacts, ppm, home, projects].map((p) => mkdir(p, { recursive: true })));

async function command(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], ...opts });
  let log = ""; child.stdout.on("data", (s) => log += s); child.stderr.on("data", (s) => log += s);
  const code = await new Promise((done, reject) => { child.on("exit", done); child.on("error", reject); });
  if (code) throw new Error(`${cmd} ${args.join(" ")} exited ${code}: ${log}`);
  return log;
}

let webDir = process.env.PPM_CHANGES_WEB_DIR;
if (!webDir) {
  webDir = join(sandbox, "web");
  await writeFile(join(artifacts, "build.log"), await command("bun", ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir]));
  // What `scripts/copy-monaco.ts` does for dist/web: the diff editor loads Monaco from here.
  cpSync(resolve("node_modules/monaco-editor/min/vs"), join(webDir, "assets/monaco/vs"), { recursive: true });
}
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), "Monaco is not staged in the web build");

const listener = createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise((r) => listener.close(r));
const web = `http://127.0.0.1:${port}`;
const env = { ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(), PPM_HTML_TEST_PORT: String(port), PPM_CHANGES_WEB_DIR: webDir };
delete env.PPM_ALLOW_PROD_DB;
const backend = spawn("bun", ["tests/e2e/fixtures/session-changes-server.ts"], { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
let serverLog = ""; backend.stdout.on("data", (s) => serverLog += s); backend.stderr.on("data", (s) => serverLog += s);

async function until(label, fn, timeout = 30000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timeout: ${label} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}
async function api(path, init = {}) {
  const response = await fetch(web + path, { ...init, headers: { "Content-Type": "application/json" } });
  const body = await response.json(); assert(response.ok, JSON.stringify(body)); return body;
}

/** A project with a committed history, so the review's "before" is plainly not git's. */
async function makeProject(name) {
  const dir = join(projects, name);
  await mkdir(join(dir, "src"), { recursive: true }); await mkdir(join(dir, "docs"), { recursive: true });
  // Two changes far enough apart to be two blocks.
  const filler = "abcdefghi".split("").map((c, i) => `export const ${c} = ${i + 1};`);
  await writeFile(join(dir, "src/app.ts"), ["// app", "export const version = 1;", 'export const name = "demo";', ...filler, "export function main() {", "  return version;", "}", ""].join("\n"));
  // Over the ~10 KB at which Claude Code stops recording a file's original in the transcript.
  const notes = Array.from({ length: 400 }, (_, i) => `- note ${i}: ${"lorem ipsum ".repeat(3)}`).join("\n") + "\n";
  assert(notes.length > 13000);
  await writeFile(join(dir, "docs/notes.md"), notes);
  await writeFile(join(dir, "README.md"), "# Demo\n\nOld readme.\n");
  await writeFile(join(dir, "src/config.json"), '{ "debug": false }\n');
  await command("git", ["init", "-q", dir]);
  await command("git", ["-C", dir, "add", "."]);
  await command("git", ["-C", dir, "-c", "user.email=e2e@invalid", "-c", "user.name=e2e", "commit", "-qm", "init"]);
  // An uncommitted change from before the session: it must NOT show up in the review.
  await writeFile(join(dir, "README.md"), "# Demo\n\nOld readme, edited by hand.\n");
  await api("/api/projects", { method: "POST", body: JSON.stringify({ name, path: dir }) });
  const created = await api(`/api/project/${name}/chat/sessions`, { method: "POST", body: JSON.stringify({ providerId: "claude", title: "Changes test" }) });
  const sessionId = created.data.id;
  const tab = { id: `chat-${sessionId}`, type: "chat", title: "Changes test", projectId: name, closable: true, metadata: { projectName: name, sessionId, providerId: "claude" } };
  await api(`/api/project/${name}/workspace`, { method: "PUT", body: JSON.stringify({ layout: { panels: { main: { id: "main", tabs: [tab], activeTabId: tab.id, tabHistory: [tab.id] } }, grid: [["main"]], focusedPanelId: "main" } }) });
  return { dir, sessionId };
}

const turnOne = (dir) => [
  { tool: "Edit", path: join(dir, "src/app.ts"), oldString: "version = 1", newString: "version = 2" },
  { tool: "Write", path: join(dir, "src/new-file.ts"), content: "export const fresh = true;\n" },
  { tool: "Edit", path: join(dir, "docs/notes.md"), oldString: "- note 200:", newString: "- NOTE 200 (edited):" },
];
const turnTwo = (dir) => [
  { tool: "Edit", path: join(dir, "src/app.ts"), oldString: "version = 2", newString: "version = 3" },
  { tool: "Edit", path: join(dir, "src/app.ts"), oldString: "  return version;", newString: "  return version + 1;" },
  { tool: "Write", path: join(dir, "README.md"), content: "# Demo\n\nRewritten by the agent.\n" },
  // Files no tool names: a copy, and an edit in place. Only `git status` around the command sees them.
  { tool: "Bash", command: "cp src/new-file.ts src/copied.ts && sed -i 's/false/true/' src/config.json", cwd: dir },
];

async function sendTurn(page, ops, message) {
  await api("/__changes-test/script", { method: "POST", body: JSON.stringify({ ops }) });
  const box = page.locator('textarea[placeholder="Ask anything..."]:visible').first();
  await box.fill(message); await box.press("Enter");
  await until(`turn "${message}" answered`, async () => (await page.getByText(`Changed ${ops.length} file`, { exact: false }).count()) > 0);
}

const barText = (page) => page.locator('[data-testid="session-changes-bar"]:visible').first().innerText();

const read = (dir, path) => existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : null;

/** The Review tab's own pieces, scoped to the one on screen. */
function reviewTab(page) {
  const root = page.locator('[data-testid="session-review"]:visible');
  return {
    root,
    blocks: root.locator("[data-block-key]"),
    focused: root.locator("[data-block-key][data-focused]"),
    rows: root.locator('[data-testid="review-file-row"]:visible'),
    row: (name) => root.locator('[data-testid="review-file-row"]:visible', { hasText: name }).first(),
    toast: root.locator('[data-testid="review-toast"]'),
    text: () => root.innerText(),
  };
}

/** The session's list as the server has it: each file's blocks and which are kept. */
async function serverList(name, sessionId) {
  const body = await api(`/api/project/${name}/chat/sessions/${sessionId}/file-changes`, { method: "POST", body: JSON.stringify({ paths: [] }) });
  return Object.fromEntries((body.data?.files ?? body.files ?? []).map((f) => [f.path.split("/").pop(), f]));
}

const chatTabOf = (page) => page.locator('[role="tab"], [data-tab-id]').filter({ hasText: /Changes test|turn one/ }).first();
const reviewTabOf = (page) => page.locator('[data-tab-id^="session-review:"]').first();
const chipNames = async (block) => (await block.locator("[data-turn-chip]").allInnerTexts()).map((t) => t.split("·")[0].trim());

/**
 * Opens the first fold, then measures every drawn line inside a block and out: each line
 * number's right edge, and the code cell's left and right edges. Each must be one column, or
 * the numbers step sideways at a card's edge.
 */
async function assertColumnsAligned(r, tap) {
  const fold = r.root.locator('[data-testid="review-code"] button', { hasText: /unchanged lines?$/ }).first();
  await (tap ? fold.tap() : fold.click());
  const measure = () => r.root.locator('[data-testid="review-code"]').evaluate((box) => {
    const at = (x) => Math.round(x * 10) / 10;
    const textRight = (cell) => {
      if (!cell.textContent) return null;
      const range = document.createRange();
      range.selectNodeContents(cell);
      return at(range.getBoundingClientRect().right);
    };
    return [...box.querySelectorAll(".grid")].filter((g) => g.children.length === 4).map((g) => {
      const code = g.children[3].getBoundingClientRect();
      return { inBlock: !!g.closest("[data-block-key]"), edges: [textRight(g.children[0]), textRight(g.children[1]), at(code.left), at(code.right)] };
    });
  });
  let lines = [];
  await until("fold opened", async () => (lines = await measure()).some((l) => !l.inBlock));
  assert(lines.some((l) => l.inBlock), "a block's lines are drawn");
  ["old line number", "new line number", "code start", "code end"].forEach((column, i) => {
    const xs = lines.map((l) => l.edges[i]).filter((x) => x !== null);
    assert(Math.max(...xs) - Math.min(...xs) <= 0.5, `${column} is one column: ${JSON.stringify(lines.map((l) => [l.inBlock ? "block" : "fold", l.edges[i]]))}`);
  });
}

async function desktopReview(page, name, sessionId, dir) {
  const r = reviewTab(page);
  const chatTab = () => chatTabOf(page);
  const reviewTabButton = () => reviewTabOf(page);
  // Opened from the bar's row for app.ts: its first block in focus, compared with the state
  // before the session (version = 1), not before the last turn.
  await until("app.ts blocks", async () => (await r.blocks.count()) === 2);
  const [one, two] = [r.blocks.nth(0), r.blocks.nth(1)];
  assert.equal(await one.getAttribute("data-focused"), "true");
  assert(/version = 1/.test(await one.innerText()) && /version = 3/.test(await one.innerText()), await one.innerText());
  assert(/return version;/.test(await two.innerText()) && /return version \+ 1;/.test(await two.innerText()));
  assert(/0 of 7 blocks decided/.test(await r.text()), "seven blocks across six files");
  await page.screenshot({ path: join(artifacts, "desktop-review.png") });
  await assertColumnsAligned(r, false);
  await page.screenshot({ path: join(artifacts, "desktop-review-fold-open.png") });

  // Each block names the turns that wrote it — the first block both — and a turn opens to the
  // prompt that asked for it, and into the chat at the call.
  await until("turn chips", async () => (await chipNames(one)).join() === "Turn 1,Turn 2");
  assert.deepEqual(await chipNames(two), ["Turn 2"]);
  await two.locator("[data-turn-chip]").first().click();
  const card = two.locator("[data-turn-pop]");
  await until("turn card", async () => (await card.locator("blockquote").innerText()) === "turn two");
  await page.screenshot({ path: join(artifacts, "desktop-review-turn.png") });
  await page.keyboard.press("Escape");
  await until("card closed", async () => (await card.count()) === 0);
  assert.equal(await two.getAttribute("data-state"), "open", "Escape answered nothing");
  await two.locator("[data-turn-chip]").first().click();
  await card.getByRole("button", { name: "Show in chat" }).click();
  await until("the chat shows the call", async () => (await page.locator("[data-flash]:visible").count()) > 0);
  await page.screenshot({ path: join(artifacts, "desktop-review-show-in-chat.png") });
  await reviewTabButton().click();
  await until("back on the review", async () => (await r.blocks.count()) === 2 && (await one.getAttribute("data-focused")) === "true");

  // Y keeps the block in focus and moves on to the next one.
  await r.root.focus();
  await page.keyboard.press("y");
  await until("block 1 kept", async () => (await one.getAttribute("data-state")) === "kept" && (await two.getAttribute("data-focused")) === "true");
  // The toast comes with the server's answer, after the block already shows it.
  await until("kept toast", async () => /Kept block 1 of\s*app\.ts/.test(await r.toast.innerText()));
  await until("kept on the server", async () => (await serverList(name, sessionId))["app.ts"]?.blocks?.[0]?.kept === true);

  // N reverts it on disk, and the finished file moves to Done.
  await page.keyboard.press("n");
  await until("block 2 reverted on disk", async () => read(dir, "src/app.ts")?.includes("  return version;\n"));
  assert(read(dir, "src/app.ts").includes("version = 3"), "only the one block went back");
  await until("app.ts done", async () => /1 kept · 1 reverted/.test(await r.row("app.ts").innerText()));
  await until("reverted toast", async () => /Reverted block 2 of\s*app\.ts/.test(await r.toast.innerText()));
  await page.screenshot({ path: join(artifacts, "desktop-review-reverted.png") });

  // Undo writes the agent's lines back and returns to the block.
  await r.toast.getByRole("button", { name: "Undo" }).click();
  await until("revert undone", async () => read(dir, "src/app.ts")?.includes("return version + 1;"));
  await until("back on block 2", async () => (await r.focused.innerText()).includes("return version + 1;") && (await r.focused.getAttribute("data-state")) === "open");

  // Change opens a kept block again.
  await one.getByRole("button", { name: "Change" }).click();
  await until("block 1 open again", async () => (await one.getAttribute("data-state")) === "open");
  await until("reopened on the server", async () => !(await serverList(name, sessionId))["app.ts"]?.blocks?.[0]?.kept);

  // J and K move between blocks.
  await r.root.focus();
  await page.keyboard.press("j");
  await until("J moves down", async () => (await two.getAttribute("data-focused")) === "true");
  await page.keyboard.press("k");
  await until("K moves up", async () => (await one.getAttribute("data-focused")) === "true");

  // Keep file answers the rest of the file, and focus moves to the next file.
  await page.getByRole("button", { name: "Keep file" }).click();
  await until("app.ts kept", async () => /\bKept\b/.test(await r.row("app.ts").innerText()));
  await until("on new-file.ts", async () => (await r.focused.innerText()).includes("fresh = true"));

  // Revert file… is confirmed first; for a file the session created it deletes it.
  await page.getByRole("button", { name: "Revert file…" }).click();
  const dialog = page.getByRole("dialog", { name: "Revert new-file.ts?" });
  assert(/Deletes\s*new-file\.ts/.test(await dialog.innerText()));
  await page.screenshot({ path: join(artifacts, "desktop-review-revert-file.png") });
  await dialog.getByRole("button", { name: "Revert file" }).click();
  await until("new-file.ts deleted", async () => read(dir, "src/new-file.ts") === null);
  await until("new-file.ts done", async () => /Reverted/.test(await r.row("new-file.ts").innerText()));
  await r.toast.getByRole("button", { name: "Undo" }).click();
  await until("new-file.ts back", async () => read(dir, "src/new-file.ts") === "export const fresh = true;\n");

  // The shell command's files are reviewed block by block like any other.
  await r.row("config.json").click();
  await until("config.json block", async () => /"debug": false/.test(await r.focused.innerText()) && /"debug": true/.test(await r.focused.innerText()));
  await r.row("copied.ts").click();
  await until("copied.ts block", async () => (await r.focused.innerText()).includes("fresh = true"));

  // Live: a third turn adds a block to a file already kept, while the tab is open.
  await r.row("notes.md").click();
  await until("on notes.md", async () => (await r.focused.innerText()).includes("NOTE 200 (edited)"));
  await page.getByRole("button", { name: "Keep file" }).click();
  await until("notes.md kept", async () => /\bKept\b/.test(await r.row("notes.md").innerText()));
  await chatTab().click();
  await sendTurn(page, [{ tool: "Edit", path: join(dir, "docs/notes.md"), oldString: "- note 300:", newString: "- NOTE 300 (third turn):" }], "turn three");
  await reviewTabButton().click();
  // Kept whole, it was marked reviewed: only what changed since is open again.
  await until("notes.md has a new open block", async () => { const t = await r.row("notes.md").innerText(); return /New since review/.test(t) && /0\/1/.test(t); });

  // Narrower than 760px of its own — a split, not a phone — the file list folds behind a button.
  await page.setViewportSize({ width: 1000, height: 800 });
  await until("rail folded", async () => (await r.root.locator('aside[aria-label="Changed files"]:visible').count()) === 0);
  await r.root.getByRole("button", { name: "6 files" }).click();
  await until("file list over the pane", async () => (await r.rows.count()) === 6);
  await page.screenshot({ path: join(artifacts, "desktop-review-narrow.png") });
  await r.row("config.json").click();
  await until("list closed on a pick", async () => (await r.rows.count()) === 0 && /"debug": true/.test(await r.focused.innerText()));
  await page.setViewportSize({ width: 1366, height: 900 });

  // A reload rebuilds the tab from the server: kept stays kept.
  await page.reload();
  await reviewTabButton().click();
  await until("review after reload", async () => (await r.rows.count()) === 6);
  assert(/\bKept\b/.test(await r.row("app.ts").innerText()));
  assert(/0\/1/.test(await r.row("notes.md").innerText()));

  // A file ticked in the changes bar shows in the tab as kept.
  await chatTab().click();
  await until("bar after reload", async () => /files changed/.test(await barText(page)));
  await page.locator('[data-testid="session-changes-bar"]:visible button', { hasText: "files changed" }).click();
  await page.locator('[data-testid="session-changes-bar"]:visible [data-testid="session-change-item"]', { hasText: "README.md" }).getByRole("checkbox").click();
  await reviewTabButton().click();
  await until("README kept in the tab", async () => /\bKept\b/.test(await r.row("README.md").innerText()));

  // Everything left at once; the bar agrees, and so does a reload.
  await page.getByRole("button", { name: "Keep all remaining" }).click();
  await until("all decided", async () => /All \d+ blocks decided/.test(await r.text()));
  await page.screenshot({ path: join(artifacts, "desktop-review-all-decided.png") });
  await chatTab().click();
  await until("all reviewed in the bar", async () => /All 6 files reviewed/.test(await barText(page)));
  await page.reload();
  await chatTab().click();
  await until("marks survive a reload", async () => /All 6 files reviewed/.test(await barText(page)));
}

async function phoneReview(page, name, sessionId, dir) {
  const r = reviewTab(page);
  const button = (label) => r.root.getByRole("button", { name: label, exact: true });
  await until("phone review", async () => (await r.blocks.count()) > 0 && /0\/7 blocks/.test(await r.text()));
  for (const label of ["All files", "File actions", "Previous block", "Next block", "Revert", "Keep"]) {
    const box = await button(label).boundingBox();
    assert(box && box.height >= 44 && box.width >= 44, `${label} is ${box?.width}x${box?.height}`);
  }
  await page.screenshot({ path: join(artifacts, "mobile-review.png") });

  // A block's turns open in a sheet. The chip is drawn small and answers a 44px press.
  const chip = r.blocks.first().locator("[data-turn-chip]").first();
  const chipBox = await chip.boundingBox();
  const hit = await page.evaluate(({ x, top, bottom }) => [top, bottom].map((y) => {
    const el = document.elementFromPoint(x, y);
    return el?.closest("[data-turn-chip]") ? "chip" : `${el?.tagName}.${el?.className}`;
  }), { x: chipBox.x + chipBox.width / 2, top: chipBox.y + chipBox.height / 2 - 21, bottom: chipBox.y + chipBox.height / 2 + 21 });
  assert.deepEqual(hit, ["chip", "chip"], `the chip answers 44px around its middle (${chipBox.height}px drawn)`);
  await chip.tap();
  const turnCard = page.locator("[data-turn-pop]:visible");
  await until("turn sheet", async () => (await turnCard.locator("blockquote").innerText()) === "turn one");
  for (const label of ["Copy prompt", "Show in chat"]) {
    const box = await turnCard.getByRole("button", { name: label }).boundingBox();
    assert(box.height >= 44, `${label} is ${box.height}px`);
  }
  await page.screenshot({ path: join(artifacts, "mobile-review-turn.png") });
  await page.touchscreen.tap(195, 40);
  await until("turn sheet closed", async () => (await turnCard.count()) === 0);
  await assertColumnsAligned(r, true);
  await page.screenshot({ path: join(artifacts, "mobile-review-fold-open.png") });

  // Keep, then Revert the next block, from the thumb zone.
  await button("Keep").tap();
  await until("one kept", async () => /1\/7 blocks/.test(await r.text()));
  await until("kept toast", async () => /Kept block 1 of\s*app\.ts/.test(await r.toast.innerText()));
  await page.screenshot({ path: join(artifacts, "mobile-review-kept.png") });
  await button("Revert").tap();
  await until("reverted on disk", async () => read(dir, "src/app.ts")?.includes("  return version;\n"));

  // Back to the reverted block: the bar offers Change, which undoes the revert.
  await until("moved on", async () => !(await r.text()).includes("Block 2 of 2"));
  await button("Previous block").tap();
  await until("on the reverted block", async () => (await r.focused.getAttribute("data-state")) === "reverted");
  const change = button("Change");
  assert((await change.boundingBox()).height >= 44, "Change is a 44px target");
  await change.tap();
  await until("revert undone", async () => read(dir, "src/app.ts")?.includes("return version + 1;"));

  // The file list as a sheet.
  await button("All files").tap();
  const rows = page.locator('[data-testid="review-file-row"]:visible');
  await until("files sheet", async () => (await rows.count()) === 6);
  for (const row of await rows.all()) assert((await row.boundingBox()).height >= 56, "sheet rows are 56px");
  assert((await page.getByRole("button", { name: "Keep all remaining" }).boundingBox()).height >= 44);
  await page.screenshot({ path: join(artifacts, "mobile-review-files.png") });
  await rows.filter({ hasText: "README.md" }).first().tap();
  await until("on README.md", async () => (await r.focused.innerText()).includes("Rewritten by the agent"));

  // Revert a whole file from its actions, confirmed in a sheet: back to the hand edit made
  // before the session, not to git HEAD.
  await button("File actions").tap();
  const revertFile = page.getByRole("button", { name: "Revert file…" });
  assert((await revertFile.boundingBox()).height >= 44);
  await revertFile.tap();
  const confirm = page.getByRole("button", { name: "Revert file", exact: true });
  await confirm.waitFor();
  await page.screenshot({ path: join(artifacts, "mobile-review-revert-file.png") });
  assert((await confirm.boundingBox()).height >= 44);
  await confirm.tap();
  await until("README back to the hand edit", async () => read(dir, "README.md") === "# Demo\n\nOld readme, edited by hand.\n");

  // Keep the rest from the sheet.
  await button("All files").tap();
  await page.getByRole("button", { name: "Keep all remaining" }).tap();
  await until("all decided", async () => /All \d+ blocks decided/.test(await r.text()));
  await page.screenshot({ path: join(artifacts, "mobile-review-all-decided.png") });
  const list = await serverList(name, sessionId);
  assert(Object.values(list).every((f) => f.reviewed), `every file left is reviewed: ${JSON.stringify(Object.keys(list))}`);
}

/** The change pill under each answer, and the tray it opens: each edit kept or reverted, and the turn. */
async function desktopTray(page, name, sessionId, dir) {
  const pills = page.locator('button[aria-label*="changed this turn"]:visible');
  await until("a pill per turn", async () => (await pills.count()) === 2);
  const [pillOne, pillTwo] = [pills.nth(0), pills.nth(1)];
  await until("turn two to review", async () => /3 edits to review/.test(await pillTwo.innerText()));
  assert(/3 edits to review/.test(await pillOne.innerText()), await pillOne.innerText());

  await pillTwo.click();
  const tray = page.locator('[data-testid="turn-change-tray"]:visible');
  await tray.waitFor();
  const edit = (file, n) => tray.locator(`[data-file-group$="${file}"] [data-edit-key]`).nth(n);
  const notice = tray.locator('[data-testid="turn-review-notice"]');
  await until("each edit's lines", async () => /version = 3/.test(await edit("app.ts", 0).innerText()) && /Rewritten by the agent/.test(await edit("README.md", 0).innerText()));
  await page.screenshot({ path: join(artifacts, "desktop-tray.png") });

  // One edit kept: its block is kept on the server, and the pill counts it.
  await edit("README.md", 0).getByRole("button", { name: "Keep" }).click();
  await until("README kept", async () => (await serverList(name, sessionId))["README.md"]?.blocks?.every((b) => b.kept));
  await until("the pill counts it", async () => /2 edits to review/.test(await pillTwo.innerText()));
  assert.equal(await edit("README.md", 0).getAttribute("data-state"), "kept");

  // Another reverted on disk, then put back.
  await edit("app.ts", 1).getByRole("button", { name: "Revert" }).click();
  await until("reverted on disk", async () => read(dir, "src/app.ts")?.includes("  return version;\n"));
  await until("revert notice", async () => /Reverted 1 block/.test(await notice.innerText()));
  await until("edit reverted", async () => (await edit("app.ts", 1).getAttribute("data-state")) === "reverted");
  await page.screenshot({ path: join(artifacts, "desktop-tray-reverted.png") });
  await notice.getByRole("button", { name: "Undo" }).click();
  await until("revert undone", async () => read(dir, "src/app.ts")?.includes("return version + 1;"));
  await until("edit open again", async () => (await edit("app.ts", 1).getAttribute("data-state")) === "open");

  // The rest at once.
  await tray.getByRole("button", { name: "Keep all" }).click();
  await until("turn two kept", async () => { const t = await pillTwo.innerText(); return /Kept/.test(t) && !/to review/.test(t); });
  await tray.getByRole("button", { name: "Close change tray" }).click();
  await until("tray closed", async () => (await tray.count()) === 0);

  // Turn one: app.ts's first block holds both turns and was kept with turn two.
  await until("turn one left", async () => /2 edits to review/.test(await pillOne.innerText()));
  await pillOne.click();
  await tray.getByRole("button", { name: "Revert turn…" }).click();
  const confirm = page.locator('[data-testid="revert-turn-confirm"]:visible');
  await until("the preview", async () => /notes\.md/.test(await confirm.innerText()));
  const text = await confirm.innerText();
  assert(/new-file\.ts[\s\S]*file removed/.test(text), text);
  assert(!(await confirm.getByText("file removed").evaluate((el) => el.scrollWidth > el.clientWidth)), "what happens to the file is not cut off");
  assert(/app\.ts line \d+ stays as it is — Turn 2 changed it again/.test(text), text);
  assert.equal(read(dir, "src/new-file.ts"), "export const fresh = true;\n", "nothing is written before it is confirmed");
  await page.screenshot({ path: join(artifacts, "desktop-tray-revert-turn.png") });
  await confirm.getByRole("button", { name: "Revert turn" }).click();
  await until("turn one reverted on disk", async () => read(dir, "src/new-file.ts") === null && !read(dir, "docs/notes.md").includes("NOTE 200"));
  assert(read(dir, "src/app.ts").includes("version = 3"), "the line turn two changed again stays");
  await until("turn notice", async () => /Reverted this turn's changes/.test(await notice.innerText()));
  await until("the pill says so", async () => /2 reverted/.test(await pillOne.innerText()));
  await page.screenshot({ path: join(artifacts, "desktop-tray-turn-reverted.png") });
  await notice.getByRole("button", { name: "Undo" }).click();
  await until("turn one back", async () => read(dir, "src/new-file.ts") === "export const fresh = true;\n" && read(dir, "docs/notes.md").includes("NOTE 200 (edited)"));

  // An edit leads to its tool card, and the tray to the Review tab.
  await tray.locator("[data-edit-key]").first().getByRole("button", { name: "Show in chat" }).click();
  await until("tray closed on the jump", async () => (await tray.count()) === 0);
  await until("the card flashes", async () => (await page.locator("[data-flash]:visible").count()) > 0);
  await pillOne.click();
  await tray.getByRole("button", { name: "Review in tab" }).click();
  await until("the review tab", async () => (await page.locator('[data-testid="session-review"]:visible').count()) === 1);
}

async function phoneTray(page, name, sessionId, dir) {
  const pills = page.locator('button[aria-label*="changed this turn"]:visible');
  await until("a pill per turn", async () => (await pills.count()) === 2);
  const pillTwo = pills.nth(1);
  assert((await pillTwo.boundingBox()).height >= 44, "the pill is a 44px target");
  await pillTwo.tap();
  const sheet = page.locator('[data-testid="turn-change-sheet"]:visible');
  await sheet.waitFor();
  const readme = sheet.locator('[data-file-group$="README.md"] [data-edit-key]').first();
  await until("each edit's lines", async () => /Rewritten by the agent/.test(await readme.innerText()));
  for (const [label, button] of [
    ["Keep", readme.getByRole("button", { name: "Keep" })],
    ["Revert", readme.getByRole("button", { name: "Revert" })],
    ["Chat", readme.getByRole("button", { name: "Chat" })],
    ["Revert turn…", sheet.getByRole("button", { name: "Revert turn…" })],
    ["Keep all 3", sheet.getByRole("button", { name: "Keep all 3" })],
    ["Close", sheet.getByRole("button", { name: "Close", exact: true })],
  ]) {
    const box = await button.boundingBox();
    assert(box && box.height >= 44 && box.width >= 44, `${label} is ${box?.width}x${box?.height}`);
  }
  await page.screenshot({ path: join(artifacts, "mobile-tray.png") });
  await readme.getByRole("button", { name: "Keep" }).tap();
  await until("README kept", async () => (await serverList(name, sessionId))["README.md"]?.blocks?.every((b) => b.kept));

  // The whole turn, asked in the same sheet, shell command included.
  await sheet.getByRole("button", { name: "Revert turn…" }).tap();
  const confirm = page.locator('[data-testid="revert-turn-confirm"]:visible');
  await until("the preview", async () => /config\.json/.test(await confirm.innerText()));
  assert.equal(await sheet.locator("h4").first().innerText(), "Revert Turn 2?");
  await page.screenshot({ path: join(artifacts, "mobile-tray-revert-turn.png") });
  const go = sheet.getByRole("button", { name: "Revert turn", exact: true });
  assert((await go.boundingBox()).height >= 44);
  await go.tap();
  await until("turn two reverted on disk", async () => {
    const app = read(dir, "src/app.ts");
    return app.includes("version = 2") && app.includes("  return version;\n") && read(dir, "src/config.json").includes("false")
      && read(dir, "src/copied.ts") === null && read(dir, "README.md") === "# Demo\n\nOld readme, edited by hand.\n";
  });
  const notice = sheet.locator('[data-testid="turn-review-notice"]');
  await until("turn notice", async () => /Reverted this turn's changes/.test(await notice.innerText()));
  await page.screenshot({ path: join(artifacts, "mobile-tray-turn-reverted.png") });
  await notice.getByRole("button", { name: "Undo" }).tap();
  await until("turn two back", async () => read(dir, "src/app.ts").includes("version = 3") && read(dir, "src/copied.ts") !== null && read(dir, "src/config.json").includes("true"));
}

const results = []; let browser;
try {
  await until("API ready", async () => (await fetch(web + "/api/health")).ok, 60000);
  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({ headless: true, ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}) });

  const desktopSize = { width: 1366, height: 900 }, phoneSize = { width: 390, height: 844 };
  // PPM_CHANGES_ONLY=mobile-tray,... runs only the named scenarios.
  const only = process.env.PPM_CHANGES_ONLY?.split(",");
  for (const [device, viewport, flow] of [["desktop", desktopSize, "review"], ["mobile", phoneSize, "review"], ["desktop", desktopSize, "tray"], ["mobile", phoneSize, "tray"]]) {
    if (only && !only.includes(`${device}-${flow}`)) continue;
    console.log("Checking", device, flow);
    const name = `changes-${device}-${flow}`;
    const { dir, sessionId } = await makeProject(name);
    const context = await browser.newContext({ viewport, serviceWorkers: "block", hasTouch: device === "mobile", isMobile: device === "mobile" });
    await context.addInitScript(() => localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null })));
    const page = await context.newPage();
    const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${web}/project/${name}`);
    await page.locator('textarea[placeholder="Ask anything..."]:visible').first().waitFor();
    assert.equal(await page.locator('[data-testid="session-changes-bar"]').count(), 0, "no bar before the session changed anything");

    await sendTurn(page, turnOne(dir), "turn one");
    await until("bar shows the first turn", async () => /3 files changed/.test(await barText(page)));
    await sendTurn(page, turnTwo(dir), "turn two");
    // Cumulative: app.ts was changed in both turns and still counts once; the shell command adds two.
    await until("bar shows both turns", async () => /6 files changed/.test(await barText(page)));
    const bar = await barText(page);
    console.log("  bar:", bar.replace(/\s+/g, " "));
    await page.screenshot({ path: join(artifacts, `${device}-bar.png`) });

    if (flow === "tray") {
      await (device === "desktop" ? desktopTray : phoneTray)(page, name, sessionId, dir);
    } else if (device === "desktop") {
      await page.locator('[data-testid="session-changes-bar"] button', { hasText: "6 files changed" }).click();
      const rows = page.locator('[data-testid="session-changes-bar"] [data-testid="session-change-row"]');
      await until("inline list", async () => (await rows.count()) === 6);
      const listed = await rows.allInnerTexts();
      console.log("  rows:", listed.map((t) => t.replace(/\s+/g, " ")));
      assert(listed[0].includes("app.ts") && listed[0].includes("src"), "project-relative, first-touched first");
      assert(listed.some((t) => t.includes("copied.ts")) && listed.some((t) => t.includes("config.json")), "the shell command's files are listed");
      assert(await page.getByText("Shell commands are followed through git", { exact: false }).first().isVisible());
      await page.screenshot({ path: join(artifacts, `${device}-list.png`) });
      await rows.first().click();
    } else {
      const toggle = page.locator('[data-testid="session-changes-bar"] button', { hasText: "6 files changed" });
      assert((await toggle.boundingBox()).height >= 44, "toggle is a 44px target");
      assert((await page.locator('[data-testid="session-changes-bar"] button', { hasText: "Review" }).boundingBox()).height >= 44);
      await toggle.tap();
      const rows = page.locator('[data-testid="session-change-row"]:visible');
      await until("sheet list", async () => (await rows.count()) === 6);
      for (const row of await rows.all()) assert((await row.boundingBox()).height >= 52, "sheet rows are 52px");
      await page.screenshot({ path: join(artifacts, `${device}-sheet.png`) });
      const reviewAll = page.getByRole("button", { name: "Review all 6 files" });
      assert((await reviewAll.boundingBox()).height >= 44);
      await reviewAll.tap();
    }

    if (flow === "review" && device === "desktop") await desktopReview(page, name, sessionId, dir);
    else if (flow === "review") await phoneReview(page, name, sessionId, dir);

    assert.deepEqual(errors, []);
    results.push({ device, flow, passed: true, bar: bar.replace(/\s+/g, " ") });
    await context.close();
  }
  console.log(JSON.stringify({ passed: true, artifacts, results }, null, 2));
} catch (error) {
  results.push({ passed: false, error: error.stack }); console.error(error); process.exitCode = 1;
  for (const context of browser?.contexts() || []) for (const page of context.pages()) await page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
} finally {
  await writeFile(join(artifacts, "results.json"), JSON.stringify({ artifacts, webDir, results }, null, 2));
  await writeFile(join(artifacts, "server.log"), serverLog);
  await browser?.close(); backend.kill();
}
