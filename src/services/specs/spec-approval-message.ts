/**
 * What a spec's chat is told after the user approves a document in the Spec pane.
 *
 * Always a message: an approval given again after the AI changed a document (the usual way back
 * through the phases) used to send nothing when the later documents were still approved, so the
 * chat sat silent with only a notification saying anything happened.
 */
import { phaseFileName, type SpecPhase } from "../../shared/spec-types.ts";
import type { SpecView } from "../../shared/spec-view.ts";

type ApprovalView = Pick<SpecView, "kind" | "current" | "order" | "phases" | "needsDrawing" | "drawing">;

const joinFiles = (files: string[]) =>
  files.length <= 1 ? files.join("") : `${files.slice(0, -1).join(", ")} and ${files.at(-1)}`;

export function approvalMessage(view: ApprovalView, phase: SpecPhase | "drawing"): string {
  const what = phase === "drawing" ? "the UI drawing" : phaseFileName(view.kind, phase);
  const lines = [`I approved ${what}.`];

  // Documents after it that were approved before this change stay approved: the AI has to say
  // whether they still hold, or Run all would build from a plan written for the old version.
  const from = phase === "drawing" ? view.order.indexOf("design") : view.order.indexOf(phase) + 1;
  const later = from < 0 ? [] : view.order.slice(from).filter((p) => view.phases[p].status === "approved").map((p) => view.phases[p].file);
  if (later.length > 0) {
    const one = later.length === 1;
    lines.push(`${joinFiles(later)} ${one ? "is" : "are"} still approved as written. If this change affects ${one ? "it" : "them"}, update ${one ? "it" : "them"} and submit again.`);
  }

  if (view.current === "execution") {
    lines.push(`${later.length > 0 ? "Otherwise every" : "Every"} document is approved: wait for me to start the tasks (Start task or Run all), do not start them yourself.`);
    return lines.join(" ");
  }
  const next = view.phases[view.current];
  if (view.current === "design" && view.needsDrawing && view.drawing !== "approved" && next.status === "approved") {
    lines.push("The UI drawing is not approved yet; wait for my review of it.");
  } else if (next.status === "stale") {
    lines.push(`${next.file} changed since I approved it: check it, then submit it again.`);
  } else if (next.submitted && next.status === "draft") {
    lines.push(`${next.file} is submitted and waits for my review.`);
  } else if (next.status !== "approved") {
    lines.push(`Go on with ${next.file}${next.status === "missing" ? "" : " (its template is there)"}, and submit it when it is ready.`);
  }
  return lines.join(" ");
}
