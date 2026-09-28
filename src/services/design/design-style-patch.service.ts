import { DESIGN_GEN_RE } from "../../shared/design-types.ts";
import { ELEMENT_TAG_RE, parsePpmId } from "../../shared/design-comment-types.ts";
import { parseTransformProps, type TransformProps } from "../../shared/design-bridge-messages-transform.ts";
import { withRecoveredDesign } from "./design-restore-journal.ts";
import { isSafeEntry } from "./design-manifest.ts";
import { snapshotDesign } from "./design-snapshots.service.ts";
import { DesignError } from "./design-error.ts";
import { takeDesignWrite } from "./design-write-rate-limit.ts";
import { changedSpan, recordEdit } from "./design-edit-undo-journal.ts";
import { resolveScopedPath } from "./preview/design-preview-scope.ts";
import { INSTRUMENT_MAX_BYTES } from "./preview/design-preview-html.ts";
import { readDesignSource, writeDesignSource } from "./source/design-source-file.ts";
import { patchStartTagStyle } from "./source/inline-style-patch.ts";

/**
 * A move or resize from the canvas, written into the element's inline `style`.
 *
 * The request names the element the way the canvas knows it — file, the gen the canvas
 * loaded, `data-ppm-id`, tag — and carries only `translate`/`width`/`height` px values
 * ({@link parseTransformProps}). Under the design's lock the server re-reads the file and
 * refuses with a 409 when its gen moved on (`stale`) or the tag at that offset is not the
 * expected one (`element-moved`), so a canvas behind an agent's edit can never write into
 * the wrong element. Only then does the write count against the rate limit, take a
 * `before-edit` snapshot, patch the style attribute and go to disk atomically, and the patch
 * is journaled so Undo can reverse exactly it.
 */

export interface StylePatchInput {
  file: string;
  gen: string;
  ppmId: number;
  tag: string;
  props: TransformProps;
}

export interface StylePatchResult {
  gen: string;
  /** Null when the edit was too large to journal; History still has the snapshot. */
  undoId: string | null;
}

/** A 409 carrying why, so the canvas can say whether to reload or reselect. */
export class StyleConflictError extends DesignError {
  constructor(reason: "stale" | "element-moved", message: string, readonly currentGen: string) {
    super(409, reason, message);
  }
}

const bad = (message: string): DesignError => new DesignError(400, "EBADSTYLE", message);

export function parseStylePatchInput(input: unknown): StylePatchInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("Expected a JSON object");
  const raw = input as Record<string, unknown>;
  if (!isSafeEntry(raw.file)) throw bad("file must be an HTML file of the design");
  if (typeof raw.gen !== "string" || !DESIGN_GEN_RE.test(raw.gen)) throw bad("Invalid gen");
  const ppmId = parsePpmId(raw.ppmId);
  if (typeof ppmId !== "number") throw bad("Invalid element id");
  const tag = typeof raw.tag === "string" ? raw.tag.toLowerCase() : "";
  if (!ELEMENT_TAG_RE.test(tag)) throw bad("Invalid tag");
  const props = parseTransformProps(raw.props);
  if (!props) throw bad("props may only set translate, width and height to px values");
  return { file: raw.file, gen: raw.gen, ppmId, tag, props };
}

export async function commitStylePatch(projectPath: string, slug: string, raw: unknown): Promise<StylePatchResult> {
  const input = parseStylePatchInput(raw);
  return withRecoveredDesign(projectPath, slug, async () => {
    const abs = (await resolveScopedPath({ projectPath, slug }, `${slug}/${input.file}`)).abs;
    // Files above this size are served without ids, so no canvas can address one of their elements.
    const source = await readDesignSource(abs, { maxBytes: INSTRUMENT_MAX_BYTES });
    if (source.gen !== input.gen) {
      throw new StyleConflictError("stale", `${input.file} changed since the canvas loaded it`, source.gen);
    }
    const patched = patchStartTagStyle(source.text, input.ppmId, input.tag, input.props);
    if ("error" in patched) throw new StyleConflictError("element-moved", patched.message, source.gen);
    takeDesignWrite(projectPath, slug);
    await snapshotDesign(projectPath, slug, "before-edit");
    const gen = await writeDesignSource(abs, patched.text, { bom: source.bom });
    const span = changedSpan(input.file, source.text, patched.text);
    const undoId = span ? recordEdit(projectPath, slug, [span], { [input.file]: gen }) : null;
    return { gen, undoId };
  });
}
