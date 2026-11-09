/**
 * One PPM process's part of the share persistence test, run by
 * `design-share-persistence.test.ts` in a fresh `bun` process each time, so a "restart" is a
 * real one: a new database connection on the same file, the share secret read again from
 * disk, every in-memory cache gone.
 *
 *   bun design-share-persistence-process.ts create <project>   sets up links and threads
 *   bun design-share-persistence-process.ts observe <project> <codes-json>   reads them back
 *
 * Prints one JSON line. Refuses to run without an isolated PPM_HOME.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const ppmHome = process.env.PPM_HOME;
if (!ppmHome || realpathSync(ppmHome).toLowerCase().startsWith(resolve(homedir(), ".ppm").toLowerCase())) {
  throw new Error("Run only with an isolated PPM_HOME");
}

const { configService } = await import("../../../src/services/config.service.ts");
const { createDesign } = await import("../../../src/services/design/design-store.service.ts");
const { addReply } = await import("../../../src/services/design/design-comment-replies.service.ts");
const links = await import("../../../src/services/design/share/design-share-links.service.ts");
const guest = await import("../../../src/services/design/share/design-share-comments.service.ts");
const { writeFileSync } = await import("node:fs");
const { join } = await import("node:path");

const [step, project, codesJson] = process.argv.slice(2);
if (!project) throw new Error("Missing project path");
const ANCHOR = { file: "index.html", ppmId: null, gen: null, tag: "h1", cssPath: "h1", quote: { exact: "Pinned", prefix: "", suffix: "" } };
const ANN = guest.guestKeyHash("a".repeat(43))!;
const BOB = guest.guestKeyHash("b".repeat(43))!;

configService.load();

async function create() {
  configService.set("auth", { ...configService.get("auth"), enabled: true, token: "persistence-test-token" });
  configService.set("projects", [{ name: "demo", path: project! }]);
  await createDesign(project!, { title: "Home", kind: "page" });
  writeFileSync(join(project!, "designs", "home", "index.html"), "<!doctype html><h1>Pinned</h1>");
  const kept = await links.createShareLink(project!, "home", { label: "Client A", expiresAt: Date.now() + 7 * 86_400_000, version: "current" });
  const revoked = await links.createShareLink(project!, "home", { label: "Client B", expiresAt: null, version: "current" });
  const resolved = (await links.resolveShareCode(kept.path!.slice(3)))!;
  const root = await guest.addGuestComment(resolved, ANN, { anchor: ANCHOR, name: "Ann", body: "Bigger headline", versionId: resolved.link.snapshotId });
  await guest.addGuestReply(resolved, BOB, root.id, { name: "Bob", body: "Agreed" });
  await addReply(project!, "home", root.id, { body: "Done" });
  await links.updateShareLink(project!, "home", revoked.id, { revoke: true });
  return { kept: { id: kept.id, path: kept.path, snapshotId: kept.snapshotId }, revoked: { id: revoked.id, path: revoked.path } };
}

async function observe() {
  const codes = JSON.parse(codesJson!) as { kept: { path: string }; revoked: { path: string } };
  const resolved = await links.resolveShareCode(codes.kept.path.slice(3));
  const listed = await links.listShareLinks(project!, "home");
  const threads = resolved ? (await guest.listGuestThreads(resolved, ANN)).threads : null;
  return {
    resolved: resolved && { id: resolved.link.id, snapshotId: resolved.link.snapshotId, label: resolved.link.label },
    revokedResolves: (await links.resolveShareCode(codes.revoked.path.slice(3))) !== null,
    listed: listed.map((l) => ({ id: l.id, label: l.label, status: l.status, path: l.path, expiresAt: l.expiresAt })),
    threads: threads?.map((t) => ({
      body: t.body, author: t.author, mine: t.mine,
      replies: t.replies.map((r) => ({ body: r.body, author: r.author, mine: r.mine })),
    })) ?? null,
  };
}

const out = step === "create" ? await create() : step === "observe" ? await observe() : null;
if (!out) throw new Error(`Unknown step: ${step}`);
console.log(`RESULT ${JSON.stringify(out)}`);
process.exit(0);
