/**
 * The two interruptions a mutation can raise: a name collision during paste, and the
 * confirmation for a delete that skips the trash.
 *
 * Both are rendered by the window body from the state `useExplorerActions` owns, so the
 * action modules stay free of React.
 */

import { Button } from "@/components/ui/button";
import type { FsEntry } from "@/lib/fs-api";
import type { ExplorerDialogState } from "./actions/use-explorer-actions";
import { ExplorerModalShell } from "./explorer-modal-shell";
import { PropertiesDialog } from "./properties-dialog";

export interface ExplorerDialogsProps {
  dialogs: ExplorerDialogState;
  platform: string | undefined;
  sep: string;
}

export function ExplorerDialogs({ dialogs, platform, sep }: ExplorerDialogsProps) {
  const { collision, pendingDelete, permanentOverwrite, properties } = dialogs;

  return (
    <>
      {collision && (
        <ExplorerModalShell
          open
          // Dismissing without choosing must not silently overwrite anything.
          onClose={() => collision.resolve("skip")}
          title="An item with that name already exists"
          description={collision.name}
          footer={
            <>
              <Button variant="outline" onClick={() => collision.resolve("skip")}>Skip</Button>
              <Button variant="outline" onClick={() => collision.resolve("keep-both")}>Keep both</Button>
              <Button variant="destructive" onClick={() => collision.resolve("replace")}>Replace</Button>
            </>
          }
        >
          <p className="py-1 text-sm text-text-2">
            Replacing moves the existing item to the Trash first, so it stays recoverable.
            Keep both adds a numbered suffix.
          </p>
        </ExplorerModalShell>
      )}

      {pendingDelete && (
        <ExplorerModalShell
          open
          onClose={dialogs.closeDelete}
          title={`Delete ${pendingDelete.paths.length} item${pendingDelete.paths.length === 1 ? "" : "s"} permanently?`}
          description="This cannot be undone — the items do not go to the Trash."
          footer={
            <>
              <Button variant="outline" onClick={dialogs.closeDelete}>Cancel</Button>
              <Button variant="destructive" onClick={dialogs.runPermanentDelete}>Delete permanently</Button>
            </>
          }
        >
          <ul className="space-y-0.5 py-1 text-sm text-text-2">
            {pendingDelete.names.slice(0, 10).map((name) => (
              <li key={name} className="truncate">{name}</li>
            ))}
            {pendingDelete.names.length > 10 && (
              <li className="text-text-subtle">and {pendingDelete.names.length - 10} more…</li>
            )}
          </ul>
        </ExplorerModalShell>
      )}

      {permanentOverwrite && (
        <ExplorerModalShell
          open
          // Dismissing without choosing must not silently delete anything.
          onClose={() => permanentOverwrite.resolve(false)}
          title="This host has no Trash"
          description={permanentOverwrite.name}
          footer={
            <>
              <Button variant="outline" onClick={() => permanentOverwrite.resolve(false)}>Cancel</Button>
              <Button variant="destructive" onClick={() => permanentOverwrite.resolve(true)}>Delete permanently</Button>
            </>
          }
        >
          <p className="py-1 text-sm text-text-2">
            Replacing this item cannot go through the Trash on this host. Deleting it
            permanently cannot be undone.
          </p>
        </ExplorerModalShell>
      )}

      {properties && (
        <PropertiesDialog
          entry={properties as FsEntry}
          platform={platform}
          sep={sep}
          onClose={dialogs.closeProperties}
        />
      )}
    </>
  );
}
