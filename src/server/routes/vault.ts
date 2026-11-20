import { Hono, type Context } from "hono";
import { err, ok } from "../../types/api.ts";
import { createLogger } from "../../services/logger.ts";
import { isVaultLockedTier, isVaultTier, VAULT_FILE_MAX_BYTES, type VaultCardAnswer, type VaultLockedTier } from "../../shared/vault.ts";
import { vaultService, VaultError, type UnlockFailure } from "../../services/vault/vault.service.ts";
import { vaultAttachments } from "../../services/vault/vault-attachments.service.ts";
import { settingsHolder, vaultGrants } from "../../services/vault/vault-grants.ts";
import { vaultUnlockBroker } from "../../services/vault/vault-unlock-broker.ts";

/**
 * `/api/vault` — Settings → Vault and the answers to the vault's chat cards. Behind PPM's auth,
 * and nothing more: the auth token is enough to list names and read the public tier, never to
 * read a locked tier. That takes the tier's password.
 *
 * - The secure tier, once its password is given here, stays open five minutes for the one
 *   Settings page that gave it (`POST /tiers/secure/unlock`, or any action carrying the password
 *   and the page's `handle`, a random value the page keeps in memory); `POST /lock` ends it. A
 *   request without that handle gets nothing from the open tier, so the auth token is never enough.
 * - The sealed tier is never kept open: every action on it carries its password.
 *
 * No body is ever logged (the access log writes method, path and an error's message only), and
 * an error answered here never contains a value or a password.
 */

const log = createLogger("vault");

export const vaultRoutes = new Hono();

type Body = Record<string, unknown>;
const body = async (c: Context): Promise<Body> => ((await c.req.json().catch(() => null)) ?? {}) as Body;

function failure(c: Context, r: UnlockFailure) {
  if (r.reason === "locked-out") return c.json({ ...err(r.message), retryAfterMs: r.retryAfterMs }, 423);
  if (r.reason === "wrong-password") return c.json({ ...err(r.message), attemptsLeft: r.attemptsLeft, retryAfterMs: r.lockedForMs || undefined }, 403);
  return c.json(err(r.message), 409);
}

function fail(c: Context, e: unknown) {
  if (e instanceof VaultError) return c.json(err(e.message), e.status);
  log.error(`vault route failed: ${(e as Error)?.name ?? "error"}`);
  return c.json(err("The vault could not complete this."), 500);
}

/**
 * A key for `tier` for one Settings action: this page's five-minute secure unlock when open (and
 * `requirePassword` is not set), else the password in the body, which for the secure tier also
 * opens that unlock for this page. The caller zeroes the key.
 */
async function keyFor(
  tier: VaultLockedTier, password: unknown, handle: unknown, requirePassword = false,
): Promise<{ ok: true; dek: Buffer } | UnlockFailure | { ok: false; reason: "need-password"; message: string }> {
  const holder = settingsHolder(handle);
  if (tier === "secure" && holder && !requirePassword) {
    const open = vaultGrants.keyFor("secure", holder, null);
    if (open) return { ok: true, dek: open };
  }
  if (typeof password !== "string" || !password) return { ok: false, reason: "need-password", message: "Type the tier's password." };
  const r = await vaultService.unlock(tier, password);
  if (!r.ok || tier !== "secure" || !holder) return r;
  vaultGrants.openSettings("secure", Buffer.from(r.dek), holder);
  return r;
}

async function withKey(c: Context, tier: VaultLockedTier, b: Body, fn: (dek: Buffer) => unknown) {
  const k = await keyFor(tier, b.password, b.handle);
  if (!k.ok) return k.reason === "need-password" ? c.json(err(k.message), 423) : failure(c, k);
  try {
    return c.json(ok(fn(k.dek)));
  } catch (e) {
    return fail(c, e);
  } finally {
    k.dek.fill(0);
  }
}

const status = () => ({ ...vaultService.status((t) => vaultGrants.settingsOpenUntil(t)), grants: vaultGrants.list().map((g) => ({ tier: g.tier, expiresAt: g.expiresAt, settings: g.settings })) });

vaultRoutes.get("/status", (c) => c.json(ok(status())));

vaultRoutes.get("/items", (c) => c.json(ok(vaultService.listItems())));

/** POST /tiers/:tier/enable `{ password }` — turns a locked tier on. */
vaultRoutes.post("/tiers/:tier/enable", async (c) => {
  const tier = c.req.param("tier");
  if (!isVaultLockedTier(tier)) return c.json(err("Only the Secure and Sealed tiers have a password."), 400);
  const b = await body(c);
  try {
    await vaultService.enableTier(tier, b.password);
    return c.json(ok(status()));
  } catch (e) {
    return fail(c, e);
  }
});

/** POST /tiers/:tier/password `{ oldPassword, newPassword }` */
vaultRoutes.post("/tiers/:tier/password", async (c) => {
  const tier = c.req.param("tier");
  if (!isVaultLockedTier(tier)) return c.json(err("Unknown tier."), 400);
  const b = await body(c);
  try {
    const r = await vaultService.changePassword(tier, b.oldPassword, b.newPassword);
    if (!r.ok) return failure(c, r);
    vaultGrants.lock(tier);
    return c.json(ok(status()));
  } catch (e) {
    return fail(c, e);
  }
});

/** POST /tiers/:tier/delete `{ password }` — forgets the tier and every item in it. */
vaultRoutes.post("/tiers/:tier/delete", async (c) => {
  const tier = c.req.param("tier");
  if (!isVaultLockedTier(tier)) return c.json(err("Unknown tier."), 400);
  const b = await body(c);
  const r = await vaultService.deleteTier(tier, b.password);
  if (!r.ok) return failure(c, r);
  vaultGrants.lock(tier);
  return c.json(ok({ removed: r.removed, status: status() }));
});

/** POST /tiers/secure/unlock `{ password }` — opens the secure tier for Settings, five minutes. */
vaultRoutes.post("/tiers/:tier/unlock", async (c) => {
  if (c.req.param("tier") !== "secure") return c.json(err("Only the Secure tier stays open; the Sealed tier asks for its password at every action."), 400);
  const b = await body(c);
  const holder = settingsHolder(b.handle);
  if (!holder) return c.json(err("This page cannot hold an unlock; reload it."), 400);
  const r = await vaultService.unlock("secure", b.password);
  if (!r.ok) return failure(c, r);
  const until = vaultGrants.openSettings("secure", r.dek, holder);
  return c.json(ok({ openUntil: until }));
});

/** POST /lock `{ tier? }` — ends every open unlock (Settings' and every chat's window). */
vaultRoutes.post("/lock", async (c) => {
  const b = await body(c);
  const tier = isVaultLockedTier(b.tier) ? b.tier : undefined;
  const closed = vaultGrants.lock(tier);
  log.info(`locked ${tier ?? "every tier"} (${closed} open unlock(s) ended)`);
  return c.json(ok({ closed }));
});

/** POST /items `{ tier, name, kind, value, note?, password? }` */
vaultRoutes.post("/items", async (c) => {
  const b = await body(c);
  if (!isVaultTier(b.tier)) return c.json(err("Pick a tier."), 400);
  const input = { tier: b.tier, name: b.name as string, kind: b.kind as never, value: b.value as string, note: b.note as string | undefined };
  if (b.tier === "public") {
    try { return c.json(ok(vaultService.addItem(input))); } catch (e) { return fail(c, e); }
  }
  return withKey(c, b.tier, b, (dek) => vaultService.addItem(input, dek));
});

/** PATCH /items/:id `{ name?, kind?, value?, note?, password? }` */
vaultRoutes.patch("/items/:id", async (c) => {
  const meta = vaultService.getMeta(c.req.param("id"));
  if (!meta) return c.json(err("No such vault item."), 404);
  const b = await body(c);
  const patch = { name: b.name as string | undefined, kind: b.kind as never, value: b.value as string | undefined, note: b.note as string | undefined };
  if (meta.tier === "public") {
    try { return c.json(ok(vaultService.updateItem(meta.id, patch))); } catch (e) { return fail(c, e); }
  }
  return withKey(c, meta.tier, b, (dek) => vaultService.updateItem(meta.id, patch, dek));
});

/** POST /items/:id/delete `{ password? }` */
vaultRoutes.post("/items/:id/delete", async (c) => {
  const meta = vaultService.getMeta(c.req.param("id"));
  if (!meta) return c.json(err("No such vault item."), 404);
  const b = await body(c);
  if (meta.tier === "public") {
    try { vaultService.deleteItem(meta.id); return c.json(ok({ deleted: true })); } catch (e) { return fail(c, e); }
  }
  return withKey(c, meta.tier, b, (dek) => { vaultService.deleteItem(meta.id, dek); return { deleted: true }; });
});

/** POST /items/:id/reveal `{ password? }` — the value, to Settings only (hidden again after 30 s). */
vaultRoutes.post("/items/:id/reveal", async (c) => {
  const meta = vaultService.getMeta(c.req.param("id"));
  if (!meta) return c.json(err("No such vault item."), 404);
  const b = await body(c);
  if (meta.tier === "public") return c.json(ok(vaultService.readPublic([meta.id])[0]));
  return withKey(c, meta.tier, b, (dek) => vaultService.readLocked(meta.tier as VaultLockedTier, [meta.id], dek)[0]);
});

/** POST /items/:id/move `{ to, passwords: { secure?, sealed? } }` — both locked tiers involved must open. */
vaultRoutes.post("/items/:id/move", async (c) => {
  const meta = vaultService.getMeta(c.req.param("id"));
  if (!meta) return c.json(err("No such vault item."), 404);
  const b = await body(c);
  if (!isVaultTier(b.to)) return c.json(err("Pick a tier."), 400);
  const passwords = (b.passwords ?? {}) as Partial<Record<VaultLockedTier, unknown>>;
  const keys: Buffer[] = [];
  try {
    // Taking an item out to the public tier always asks for its tier's password.
    const keyOf = async (tier: VaultLockedTier) => {
      const k = await keyFor(tier, passwords[tier], b.handle, b.to === "public" && tier === meta.tier);
      if (!k.ok) return k;
      keys.push(k.dek);
      return k;
    };
    const from = isVaultLockedTier(meta.tier) ? await keyOf(meta.tier) : null;
    if (from && !from.ok) return from.reason === "need-password" ? c.json(err(from.message), 423) : failure(c, from);
    const to = isVaultLockedTier(b.to) ? await keyOf(b.to) : null;
    if (to && !to.ok) return to.reason === "need-password" ? c.json(err(to.message), 423) : failure(c, to);
    return c.json(ok(vaultService.moveItem(meta.id, b.to, { from: from?.dek ?? null, to: to?.dek ?? null })));
  } catch (e) {
    return fail(c, e);
  } finally {
    for (const k of keys) k.fill(0);
  }
});

// ---------------------------------------------------------------------------
// Files attached to an item (secure and sealed tiers only)
// ---------------------------------------------------------------------------

/** The multipart envelope around one file: the file itself plus a few short fields. */
const UPLOAD_OVERHEAD_BYTES = 64 * 1024;

/**
 * POST /items/:id/files — multipart: `file`, `label?`, `password?`, `handle`. The browser has
 * already shrunk a photo and dropped its EXIF unless the user kept the original; the server takes
 * the bytes as they come and decides their type from them.
 */
vaultRoutes.post("/items/:id/files", async (c) => {
  const meta = vaultService.getMeta(c.req.param("id"));
  if (!meta) return c.json(err("No such vault item."), 404);
  if (!isVaultLockedTier(meta.tier)) return c.json(err("Files can only be attached to Secure and Sealed items."), 400);
  // A browser's multipart upload always declares its length; one that does not is not read at all.
  const declared = Number(c.req.header("content-length") ?? "");
  if (!Number.isFinite(declared) || declared <= 0) return c.json(err("The upload must declare its length."), 411);
  if (declared > VAULT_FILE_MAX_BYTES + UPLOAD_OVERHEAD_BYTES) return c.json(err(`A file may be at most ${VAULT_FILE_MAX_BYTES / (1024 * 1024)} MB.`), 413);
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.file;
  if (!form || !(file instanceof File)) return c.json(err("Choose a file."), 400);
  if (file.size > VAULT_FILE_MAX_BYTES) return c.json(err(`A file may be at most ${VAULT_FILE_MAX_BYTES / (1024 * 1024)} MB.`), 413);
  const bytes = Buffer.from(await file.arrayBuffer());
  try {
    return await withKey(c, meta.tier, { password: form.password, handle: form.handle }, (dek) =>
      vaultAttachments.add(meta.id, { fileName: file.name, label: typeof form.label === "string" ? form.label : undefined, bytes }, dek));
  } finally {
    bytes.fill(0);
  }
});

/**
 * POST /files/:fileId/content `{ password?, handle, download? }` — the decrypted file, to this page
 * only. Never cached, never sniffed, and only ever one of the four types the vault stores. A POST,
 * so a sealed tier's password is never part of a URL.
 */
vaultRoutes.post("/files/:fileId/content", async (c) => {
  const att = vaultAttachments.getMeta(c.req.param("fileId"));
  if (!att) return c.json(err("No such file."), 404);
  const item = vaultService.getMeta(att.itemId);
  if (!item || !isVaultLockedTier(item.tier)) return c.json(err("No such file."), 404);
  const b = await body(c);
  const k = await keyFor(item.tier, b.password, b.handle);
  if (!k.ok) return k.reason === "need-password" ? c.json(err(k.message), 423) : failure(c, k);
  try {
    const content = vaultAttachments.read(att.id, k.dek);
    const name = encodeURIComponent(content.fileName);
    log.info(`file=${att.id} opened (${b.download === true ? "download" : "preview"})`);
    return new Response(new Uint8Array(content.bytes), {
      headers: {
        "content-type": content.meta.type,
        "content-length": String(content.bytes.length),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "content-disposition": `${b.download === true ? "attachment" : "inline"}; filename*=UTF-8''${name}`,
      },
    });
  } catch (e) {
    return fail(c, e);
  } finally {
    k.dek.fill(0);
  }
});

/** PATCH /files/:fileId `{ label, password?, handle }` */
vaultRoutes.patch("/files/:fileId", async (c) => {
  const att = vaultAttachments.getMeta(c.req.param("fileId"));
  const item = att ? vaultService.getMeta(att.itemId) : null;
  if (!att || !item || !isVaultLockedTier(item.tier)) return c.json(err("No such file."), 404);
  const b = await body(c);
  return withKey(c, item.tier, b, (dek) => vaultAttachments.rename(att.id, b.label, dek));
});

/** POST /files/:fileId/delete `{ password?, handle }` */
vaultRoutes.post("/files/:fileId/delete", async (c) => {
  const att = vaultAttachments.getMeta(c.req.param("fileId"));
  const item = att ? vaultService.getMeta(att.itemId) : null;
  if (!att || !item || !isVaultLockedTier(item.tier)) return c.json(err("No such file."), 404);
  const b = await body(c);
  return withKey(c, item.tier, b, (dek) => { vaultAttachments.remove(att.id, dek); return { deleted: true }; });
});

/** POST /cards/:requestId — body `VaultCardAnswer`: the user's answer to a vault card in a chat. */
vaultRoutes.post("/cards/:requestId", async (c) => {
  const b = (await c.req.json().catch(() => null)) as Partial<VaultCardAnswer> | null;
  const r = await vaultUnlockBroker.answer(c.req.param("requestId"), b);
  if (!r.ok) return c.json({ ...err(r.error), attemptsLeft: r.attemptsLeft, retryAfterMs: r.retryAfterMs }, r.status);
  return c.json(ok(r.result));
});

/** GET /cards/:requestId/prefill — the value an AI put into a proposal, for its card to show masked. */
vaultRoutes.get("/cards/:requestId/prefill", (c) => {
  const id = c.req.param("requestId");
  if (!vaultUnlockBroker.has(id)) return c.json(err("This card is no longer waiting."), 404);
  return c.json(ok({ value: vaultUnlockBroker.prefill(id) }));
});
