/**
 * A self-contained transfer runner for the drop surfaces that live outside an explorer
 * window's action set: the places sidebar, the breadcrumb and the project file tree.
 *
 * Those three are rendered by components that never receive `ExplorerActions`, so they own
 * the two interruptions `transfer()` can raise (name collision, and a Replace on a host with
 * no Trash) themselves. The dialogs are the very same components the window body renders —
 * only the promise wiring is local — so a collision looks identical wherever the drop landed.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TransferContext } from "../actions/explorer-actions-clipboard";
import { uploadEntries } from "../actions/explorer-actions-upload";
import { useCollisionPrompt } from "../actions/use-collision-prompt";
import type { ExplorerDialogState } from "../actions/use-explorer-actions";
import { ExplorerDialogs } from "../explorer-dialogs";
import type { DroppedEntry } from "../upload/collect-dropped-entries";
import { transferRunner, type DropRunner } from "./entry-drop-executor";

export interface DropTransfer {
  run: DropRunner;
  /** Upload dropped OS files into a directory, through the same collision prompt as `run`. */
  uploadRun: (entries: DroppedEntry[], dstDir: string) => Promise<void>;
  /** Render this somewhere inside the surface — it is empty until a prompt is raised. */
  prompts: ReactNode;
}

export function useDropTransfer(sep: string, platform?: string): DropTransfer {
  const collisionPrompt = useCollisionPrompt();
  const [permanentOverwrite, setPermanentOverwrite] = useState<ExplorerDialogState["permanentOverwrite"]>(null);

  // The separator can change under a long-lived surface (the tree follows the active
  // project), so the context reads it live rather than closing over the first value.
  // Assigned in an effect, not during render — React may discard a render before commit.
  const sepRef = useRef(sep);
  useEffect(() => { sepRef.current = sep; }, [sep]);

  // Read through a ref so `context`'s identity stays stable across renders — see the same
  // pattern in `use-explorer-actions.ts`.
  const collisionPromptRef = useRef(collisionPrompt);
  collisionPromptRef.current = collisionPrompt;

  const context = useMemo<TransferContext>(
    () => ({
      get sep() {
        return sepRef.current;
      },
      resolve: (request) => collisionPromptRef.current.resolve(request),
      startBatch: () => collisionPromptRef.current.startBatch(),
      endBatch: () => collisionPromptRef.current.endBatch(),
      confirmPermanentOverwrite: (name: string) =>
        new Promise<boolean>((resolve) => {
          setPermanentOverwrite({
            name,
            resolve: (proceed) => {
              setPermanentOverwrite(null);
              resolve(proceed);
            },
          });
        }),
    }),
    [],
  );

  const run = useMemo<DropRunner>(() => transferRunner(context), [context]);
  const uploadRun = useMemo(
    () => (entries: DroppedEntry[], dstDir: string) => uploadEntries(entries, dstDir, sepRef.current, context),
    [context],
  );

  const prompts = (
    <ExplorerDialogs
      dialogs={{
        collision: collisionPrompt.state,
        permanentOverwrite,
        pendingDelete: null,
        properties: null,
        inlineError: null,
        closeDelete: () => {},
        runPermanentDelete: () => {},
        closeProperties: () => {},
        uploadInputs: null,
      }}
      platform={platform}
      sep={sep}
    />
  );

  return { run, uploadRun, prompts };
}
