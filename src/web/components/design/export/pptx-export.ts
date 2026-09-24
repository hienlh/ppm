import PptxGenJS from "pptxgenjs";
import { mapSlideDocToPptx } from "@/lib/design/pptx-slide-mapper";
import { EXPORT_BLOB_TYPE, saveBlobAsFile } from "@/lib/design/design-export-client";
import type { SlideDoc } from "../../../../shared/design-slide-doc";

/**
 * The PowerPoint writer. Reached only through `import()` from the export hook, so pptxgenjs
 * (and the jszip it brings) lands in a chunk of its own that nobody downloads until they
 * export a deck — it must never be imported statically from anywhere else.
 *
 * The plan from {@link mapSlideDocToPptx} is replayed call for call; the file is written as a
 * Blob and saved as octet-stream like every other export, rather than through pptxgenjs's
 * own `writeFile` (which would create a typed blob URL of its own).
 */
export async function exportSlidesToPptx(doc: SlideDoc, opts: { fileName: string; title: string }): Promise<string[]> {
  const plan = mapSlideDocToPptx(doc);
  const pptx = new PptxGenJS();
  if (plan.layout === "LAYOUT_WIDE") {
    pptx.layout = "LAYOUT_WIDE";
  } else {
    pptx.defineLayout(plan.layout);
    pptx.layout = plan.layout.name;
  }
  pptx.title = opts.title;
  for (const planned of plan.slides) {
    const slide = pptx.addSlide();
    if (planned.background) slide.background = planned.background;
    for (const op of planned.ops) {
      if (op.kind === "text") slide.addText(op.runs, op.options);
      else if (op.kind === "shape") slide.addShape(op.shape, op.options);
      else slide.addImage(op.options);
    }
  }
  const out = await pptx.write({ outputType: "blob" });
  if (!(out instanceof Blob)) throw new Error("The PowerPoint writer returned no file");
  saveBlobAsFile(new Blob([out], { type: EXPORT_BLOB_TYPE }), opts.fileName);
  return plan.warnings;
}
