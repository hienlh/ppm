import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DESIGN_GEN_RE, type DesignSummary } from "../../shared/design-types.ts";
import type { DesignComment } from "../../shared/design-comment-types.ts";
import { readComments, writeComments } from "./comments/design-comments-store.ts";
import { isVariantFileName } from "../../shared/design-variants.ts";
import { withRecoveredDesign } from "./design-restore-journal.ts";
import { MANIFEST_FILE, serializeManifest, type DesignManifest } from "./design-manifest.ts";
import { loadManifest, summarize } from "./design-store.service.ts";
import { resolveDesignVariants } from "./design-variants-resolve.ts";
import { takeSnapshotLocked } from "./design-snapshots.service.ts";
import { readDesignFileSafe } from "./design-safe-walk.ts";
import { writeFileAtomic } from "./design-fs.ts";
import { decodeDesignText, MAX_DESIGN_SOURCE_BYTES } from "./source/design-source-file.ts";
import { forgetDesignEdits } from "./design-edit-undo-journal.ts";
import { emitDesignEvent } from "./design-events.ts";
import { DesignError } from "./design-error.ts";

/**
 * "Use this variant": keep one variant as the design's entry page and delete the others.
 *
 * The one destructive canvas action, so it is ordered to stay recoverable: under the design
 * lock, the chosen file must still have the gen the canvas showed (a turn that rewrote it
 * since is a 409, never a silent pick of something the user did not see), then the current
 * tree is snapshotted — and a design too large to snapshot is refused, since the deleted
 * variants would then exist nowhere — and only then are files written. The chosen page's
 * bytes replace the entry's under the entry's name, so its relative links keep working (all
 * variants sit at the top of the folder), and `design.json` ends up listing the entry alone.
 */

export interface VariantPickInput {
  file: string;
  gen: string;
}

export interface VariantPickResult {
  design: DesignSummary;
  /** The snapshot holding every variant: a new `pre-variant-pick` one, or an identical older one. */
  snapshotId: string;
}

const bad = (message: string): DesignError => new DesignError(400, "EBADVARIANT", message);

export function parseVariantPickInput(input: unknown): VariantPickInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("Expected a JSON object");
  const { file, gen } = input as Record<string, unknown>;
  if (!isVariantFileName(file)) throw bad("file must name one of the design's variants");
  if (typeof gen !== "string" || !DESIGN_GEN_RE.test(gen)) throw bad("gen must be the gen the canvas loaded");
  return { file, gen };
}

const sameFile = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Where each comment belongs once `kept` is the design's only page. A note on the kept
 * variant follows it to the entry's name, so its pin stays on the element it was made on.
 * A note on any other variant — including the entry, when that is not the one kept — was
 * about a direction that is gone: it is resolved rather than deleted, because comments are
 * not part of snapshots and a deleted one could not come back with the restore. Returns
 * null when nothing changes.
 */
export function commentsAfterVariantPick(
  comments: readonly DesignComment[], kept: string, entry: string, variantFiles: readonly string[], now: string,
): DesignComment[] | null {
  let changed = false;
  const next = comments.map((c) => {
    if (sameFile(c.file, kept)) {
      if (c.file === entry) return c;
      changed = true;
      return { ...c, file: entry, anchor: { ...c.anchor, file: entry }, updatedAt: now };
    }
    if (!variantFiles.some((f) => sameFile(f, c.file)) || c.resolvedAt) return c;
    changed = true;
    return { ...c, resolvedAt: now, updatedAt: now };
  });
  return changed ? next : null;
}

export async function pickDesignVariant(projectPath: string, slug: string, raw: unknown): Promise<VariantPickResult> {
  const input = parseVariantPickInput(raw);
  // Set once the snapshot exists: from then on History must be told about it, whatever
  // happens to the writes after it, since it may hold the only copy of what they removed.
  let snapshotCreated = false;
  let commentsMoved = false;
  const target = { projectPath: resolve(projectPath), slug };
  try {
    return await withRecoveredDesign(projectPath, slug, async (dir) => {
      const { manifest, valid, raw: manifestRaw } = await loadManifest(dir, slug);
      if (manifestRaw === null || !valid) throw new DesignError(409, "EBADMANIFEST", `${MANIFEST_FILE} is missing or not a valid JSON object`);
      const { variants } = await resolveDesignVariants(dir, manifest);
      if (variants.length < 2) throw new DesignError(409, "ENOVARIANTS", "This design has only one variant");
      const chosen = variants.find((v) => v.file === input.file);
      if (!chosen) throw new DesignError(404, "ENOVARIANT", `${input.file} is not a variant of this design`);

      const chosenBytes = await readDesignFileSafe(join(dir, chosen.file), MAX_DESIGN_SOURCE_BYTES);
      if (decodeDesignText(chosenBytes, { lossy: true }).gen !== input.gen) {
        throw new DesignError(409, "ESTALE", `${chosen.file} changed since the canvas loaded it; look at it again before keeping it`);
      }

      const snapshot = await takeSnapshotLocked(dir, "pre-variant-pick");
      if ("skipped" in snapshot && snapshot.skipped !== "unchanged") {
        throw new DesignError(409, "ETOOLARGE", "The design is too large to back up, so the other variants could not be recovered");
      }
      snapshotCreated = "id" in snapshot;
      const snapshotId = "id" in snapshot ? snapshot.id : snapshot.sameAs;

      // Before any write: the undo journal's entries describe pages that are about to be
      // replaced, and an Undo replayed onto the kept page would paste old text into it.
      forgetDesignEdits(projectPath, slug);
      // The entry and the manifest first, so a failure further down leaves a design whose
      // entry page and label agree; the leftover variant files are then merely unlisted.
      if (chosen.file !== manifest.entry) await writeFileAtomic(join(dir, manifest.entry), chosenBytes);
      const now = new Date().toISOString();
      const next: DesignManifest = {
        ...manifest,
        updatedAt: now,
        extra: { ...manifest.extra, variants: [{ file: manifest.entry, label: chosen.label }] },
      };
      await writeFileAtomic(join(dir, MANIFEST_FILE), serializeManifest(next));
      const comments = commentsAfterVariantPick(await readComments(dir), chosen.file, manifest.entry, variants.map((v) => v.file), now);
      if (comments) {
        await writeComments(dir, comments);
        commentsMoved = true;
      }
      for (const v of variants) {
        if (v.file === manifest.entry) continue;
        // A locked file (Windows) must not turn a finished pick into an error: the page is
        // no longer listed, so it is invisible, and the snapshot already holds it.
        await rm(join(dir, v.file), { force: true })
          .catch((e: Error) => console.warn(`[design] ${slug}: could not delete ${v.file} after keeping ${chosen.file}: ${e.message}`));
      }
      return { design: await summarize(dir, slug, next), snapshotId };
    });
  } finally {
    if (snapshotCreated) emitDesignEvent("history_changed", target);
    if (commentsMoved) emitDesignEvent("comments_changed", target);
  }
}
