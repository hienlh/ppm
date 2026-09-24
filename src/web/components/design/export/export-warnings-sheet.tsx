import { TriangleAlert } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { DesignResponsiveDialog } from "../dialogs/design-responsive-dialog";
import type { DesignExportFeature } from "./use-design-export";

/**
 * What an export could not reproduce exactly: CSS the PowerPoint file approximates, or
 * assets the HTML file keeps as links. Shown after the file has been saved, so it explains
 * the result rather than standing in its way. The lines come from the frame and the server
 * and are rendered as plain text.
 */
export function ExportWarningsSheet({ feature }: { feature: DesignExportFeature }) {
  const warnings = feature.warnings;
  return (
    <DesignResponsiveDialog
      open={!!warnings}
      onClose={feature.dismissWarnings}
      title={warnings?.title ?? ""}
      description="The file was saved. These parts could not be carried over exactly."
      footer={<Button onClick={feature.dismissWarnings}>OK</Button>}
    >
      {warnings && (
        <ul className="flex flex-col gap-1.5 text-sm">
          {warnings.items.map((item, i) => (
            <li key={i} className="flex gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-text-subtle" />
              <span className="min-w-0 break-words">{item}</span>
            </li>
          ))}
          {warnings.items.length === 0 && <li className="text-text-subtle">No details were reported.</li>}
        </ul>
      )}
    </DesignResponsiveDialog>
  );
}
