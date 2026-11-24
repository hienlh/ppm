/**
 * Who owns a schedule, end to end on an isolated stack (scratch PPM_HOME, mock provider, Vite):
 * three script schedules with no owner and a session trace stored the way Claude's answers really
 * are; `ppm schedule owners --dry-run` (the real CLI, through the scratch server) and the API list
 * what would be linked — the manager-made review watch going to the chat it reports to — and write
 * nothing; linking writes it; then "Owned by chat" on the Schedules card and in the edit form, at
 * 390 and 1440, moving one schedule to another chat and back.
 *
 *   PPM_PLAYWRIGHT_MODULE=<playwright-core>/index.mjs PPM_PLAYWRIGHT_CHANNEL=chrome \
 *   PPM_OWNERS_SHOTS=<dir> node tests/e2e/schedule-owners-e2e.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHtmlPreviewHarness } from "./fixtures/html-preview-harness.mjs";
import { bootProject, until } from "./fixtures/new-chat-instant-helpers.mjs";

const PROJECT = "ppm-owners";
let failures = 0;
const check = (ok, label, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`); if (!ok) failures++; };

const harness = await createHtmlPreviewHarness({ serverScript: "tests/e2e/fixtures/schedule-owners-server.ts" });
const SHOTS = resolve(process.env.PPM_OWNERS_SHOTS ?? join(harness.artifacts, "schedule-owners"));
await mkdir(SHOTS, { recursive: true });
const api = (path, init) => fetch(`${harness.api}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } }).then((r) => r.json());

/** Opens the Schedules window (desktop) or tab (phone) and its detail of schedule `id`. */
async function openDetail(page, id) {
  await page.evaluate(async (sid) => {
    const { openSchedules } = await import("/components/schedules/open-schedules.ts");
    openSchedules({ select: sid });
  }, id);
  const detail = page.locator(`[data-schedule-detail="${id}"]`).last();
  // The list takes a selection only when it mounts: an open window is selected by its row.
  if (!(await detail.isVisible().catch(() => false))) {
    const row = page.locator(`[data-schedule-row="${id}"]`).first();
    await row.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    if (await row.isVisible().catch(() => false) && !(await detail.isVisible().catch(() => false))) await row.click();
  }
  await detail.waitFor({ state: "visible", timeout: 20000 });
  return detail;
}

try {
  const created = await fetch(`${harness.api}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: harness.project, name: PROJECT }) });
  check(created.ok, "project registered");
  const seeded = await api("/__owners-test/seed", { method: "POST", body: JSON.stringify({ name: PROJECT, path: harness.project }) });
  const { slack, review, pic } = seeded.schedules;
  const { chats } = seeded;

  // ---------------------------------------------------------------- dry run: CLI and API
  const ppmHome = join(harness.sandbox, "ppm");
  const cli = spawnSync(process.env.PPM_BUN || "bun", ["src/index.ts", "schedule", "owners", "--dry-run"], {
    cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 60000,
    env: { ...process.env, PPM_HOME: ppmHome, HOME: join(harness.sandbox, "home"), USERPROFILE: join(harness.sandbox, "home"), NO_COLOR: "1" },
  });
  const cliOut = `${cli.stdout ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
  console.log("--- ppm schedule owners --dry-run ---\n" + cliOut.trim() + "\n---");
  check(cli.status === 0, "CLI dry run exits 0", `${cli.status} ${cli.stderr?.slice(0, 300) ?? ""}`);
  check(cliOut.includes(`#${review} review-queue-watch → QL Review PR`) && cliOut.includes("its script reports to it; created by Project manager"),
    "CLI names the review chat for the watch the manager made");
  check(cliOut.includes(`#${slack} slack-watch → QL Slack`) && cliOut.includes(`#${pic} prod-issue-watch → PIC this week`), "CLI names the creators of the other two");
  check(cliOut.includes("Dry run: nothing was written"), "CLI says nothing was written");

  const dry = await api("/api/schedules/owners");
  check(dry.data.plans.length === 3, "API dry run lists three", JSON.stringify(dry.data.plans.map((p) => [p.id, p.ownerTitle, p.reason])));
  const before = (await api("/api/schedules")).data;
  check(before.every((s) => s.created_by_session_id === null), "dry run wrote nothing");

  const linked = await api("/api/schedules/owners", { method: "POST" });
  check(linked.data.linked === 3, "linking writes three", String(linked.data.linked));
  const after = Object.fromEntries((await api("/api/schedules")).data.map((s) => [s.id, s.created_by_session_id]));
  check(after[review] === chats.review.id && after[slack] === chats.slack.id && after[pic] === chats.pic.id, "each schedule now has its chat");
  const again = await api("/api/schedules/owners", { method: "POST" });
  check(again.data.linked === 0 && again.data.plans.length === 0, "a second run changes nothing");
  // One left without an owner, for the pictures of a schedule nobody owns.
  await api(`/api/schedules/${pic}/owner`, { method: "PATCH", body: JSON.stringify({ sessionId: null }) });
  const chip = (await api(`/api/schedules?session=${chats.review.id}`)).data.map((s) => s.name);
  check(chip.includes("review-queue-watch"), "the review chat's chip lists the watch", JSON.stringify(chip));

  // ---------------------------------------------------------------- the UI, at 390 and 1440
  for (const phone of [true, false]) {
    const tag = phone ? "phone-390" : "desktop-1440";
    const context = await harness.browser.newContext(phone
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: "reduce" }
      : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.on("pageerror", (e) => console.log(`[pageerror ${tag}] ${e.message}`));
    await bootProject(page, harness.web, PROJECT);
    const detail = await openDetail(page, review).catch(async (e) => {
      await page.screenshot({ path: join(SHOTS, `debug-${tag}-no-detail.png`) });
      throw e;
    });
    const owner = detail.locator(`[data-schedule-owner="${review}"]`);
    await until("the owner chat's title", async () => (await owner.innerText()).includes("QL Review PR"), { timeout: 15000 });
    check((await owner.innerText()).includes("QL Review PR"), `${tag}: card shows the owner`);
    await owner.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, `${tag}-card-owner.png`) });

    // Move it to the manager, then back, through the card.
    await owner.click();
    const option = page.getByRole("option", { name: "Project manager" });
    await option.waitFor({ state: "visible", timeout: 10000 });
    await page.screenshot({ path: join(SHOTS, `${tag}-card-owner-open.png`) });
    await option.click();
    await until("the owner moved", async () => (await api("/api/schedules")).data.find((s) => s.id === review).created_by_session_id === chats.manager.id, { timeout: 10000 });
    check(true, `${tag}: picking a chat moves the owner`);
    await owner.click();
    await page.getByRole("option", { name: "QL Review PR" }).click();
    await until("the owner moved back", async () => (await api("/api/schedules")).data.find((s) => s.id === review).created_by_session_id === chats.review.id, { timeout: 10000 });
    check(true, `${tag}: and back`);

    // A schedule nobody owns, then the edit form.
    const picDetail = await openDetail(page, pic);
    const picOwner = picDetail.locator(`[data-schedule-owner="${pic}"]`);
    await until("no owner shown", async () => (await picOwner.innerText()).includes("No chat"), { timeout: 15000 });
    check(true, `${tag}: a schedule nobody owns says No chat`);
    await picOwner.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, `${tag}-card-no-owner.png`) });

    await picDetail.getByRole("button", { name: "Edit" }).click();
    const formOwner = page.locator(`[data-schedule-owner="${pic}"][data-owner-place="form"]`);
    await formOwner.waitFor({ state: "visible", timeout: 15000 });
    await formOwner.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, `${tag}-form-owner.png`) });
    await formOwner.click();
    await page.getByRole("option", { name: "PIC this week" }).click();
    await until("the form set the owner", async () => (await api("/api/schedules")).data.find((s) => s.id === pic).created_by_session_id === chats.pic.id, { timeout: 10000 });
    check(true, `${tag}: the form's field sets the owner at once`);
    await page.screenshot({ path: join(SHOTS, `${tag}-form-owner-set.png`) });
    // Leave it unowned again for the next viewport's pictures.
    await api(`/api/schedules/${pic}/owner`, { method: "PATCH", body: JSON.stringify({ sessionId: null }) });
    await context.close();
  }

  // A chat of another project is refused by the route the field uses.
  const foreign = await fetch(`${harness.api}/api/schedules/${review}/owner`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "ffffffff-0000-4000-8000-00000000ffff" }) });
  check(foreign.status === 400, "an unknown chat is refused", String(foreign.status));
} catch (e) {
  failures++;
  console.log(`FAIL threw — ${e?.stack ?? e}`);
} finally {
  await harness.browser.close();
  await harness.cleanup();
}
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`} · screenshots in ${SHOTS}`);
process.exit(failures === 0 ? 0 : 1);
