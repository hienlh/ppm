import { useEffect, useState } from "react";
import { Loader2 } from "@/lib/icons";
import { previewDesignShareRepin } from "@/lib/design/api-design-shares";
import type { DesignShareChangedFiles, DesignShareLink } from "../../../../shared/design-share-types";
import { useDesignTab } from "../design-tab-context";
import { ShareChangedFiles } from "./share-changed-files";
import { Panel } from "./share-row-panel";
import type { ShareLinksFeature } from "./use-share-links";

/**
 * The "Update to latest version" step: lists the files reviewers would get that differ from
 * the version they have now, so anything that should not be in the design folder is seen
 * before it is shared. Confirm waits for the list; a list that could not be read is said so
 * and does not block the update.
 */

type Preview =
  | { state: "loading" }
  | { state: "ready"; files: DesignShareChangedFiles | null }
  | { state: "error"; message: string };

export function ShareRepinPanel({ link, links, onClose, onRepinned }: {
  link: DesignShareLink;
  links: ShareLinksFeature;
  onClose: () => void;
  onRepinned: (files: DesignShareChangedFiles | null) => void;
}) {
  const { projectName, slug } = useDesignTab();
  const [preview, setPreview] = useState<Preview>({ state: "loading" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    previewDesignShareRepin(projectName, slug, link.id)
      .then((files) => { if (live) setPreview({ state: "ready", files }); })
      .catch((e: Error) => { if (live) setPreview({ state: "error", message: e.message || "Could not list the changes" }); });
    return () => { live = false; };
  }, [projectName, slug, link.id]);

  const nothingChanged = preview.state === "ready" && !!preview.files
    && preview.files.added.length + preview.files.changed.length + preview.files.removed.length === 0;

  const confirm = async () => {
    setBusy(true);
    const result = await links.update(link.id, { repin: true }, "Could not update the version");
    setBusy(false);
    if (result) onRepinned(result.changedFiles ?? null);
  };

  return (
    <Panel confirm="Update to latest" busy={busy || preview.state === "loading"} onCancel={onClose} onConfirm={() => void confirm()}>
      <p>Saves the design as it is now and pins this link to it. Reviewers will see the new version; their
        older pins re-anchor where they can or show as detached.</p>
      <div data-testid="share-repin-preview">
        <p className="mb-2 font-medium">{nothingChanged ? "Nothing changed since this link's version." : "Files reviewers would get that differ from their version:"}</p>
        {preview.state === "loading" && (
          <p className="flex items-center gap-2 text-text-subtle"><Loader2 className="size-4 animate-spin" /> Comparing with the live design…</p>
        )}
        {preview.state === "error" && <p className="text-destructive" role="alert">{preview.message}</p>}
        {preview.state === "ready" && !nothingChanged && <ShareChangedFiles files={preview.files} />}
      </div>
    </Panel>
  );
}
