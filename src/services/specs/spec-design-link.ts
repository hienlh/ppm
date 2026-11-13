/**
 * A spec whose requirements say `UI: yes` is drawn as a PPM Design before its design is
 * approved. The drawing is an ordinary design folder (`designs/<slug>/`); what the user approves
 * is a hash of its files, so a later change to the drawing reopens the approval exactly as an
 * edited document does.
 */
import { createHash } from "node:crypto";
import { createDesign } from "../design/design-store.service.ts";
import { resolveDesignDir } from "../design/design-paths.ts";
import { readDesignFileSafe, safeWalkDesignTree } from "../design/design-safe-walk.ts";

/** The manifest changes with a rename or PPM's own bookkeeping; the drawing is everything else. */
const NOT_DRAWING = new Set(["design.json"]);

/** sha256 over the drawing's files (path and content), or null when there is no drawing. */
export async function drawingHash(projectPath: string, designSlug: string): Promise<string | null> {
  let dir: string;
  try {
    dir = await resolveDesignDir(projectPath, designSlug);
  } catch {
    return null;
  }
  const h = createHash("sha256");
  let files = 0;
  for await (const entry of safeWalkDesignTree(dir)) {
    if (NOT_DRAWING.has(entry.rel)) continue;
    h.update(entry.rel).update("\0").update(await readDesignFileSafe(entry.abs)).update("\0");
    files++;
  }
  return files ? h.digest("hex") : null;
}

/** Creates the spec's design folder; returns its slug. */
export async function createSpecDrawing(projectPath: string, title: string): Promise<string> {
  const d = await createDesign(projectPath, { title: `${title} — screens`, kind: "page" });
  return d.slug;
}
