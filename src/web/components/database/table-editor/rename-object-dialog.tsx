/**
 * DBGate's "Rename object": the new name of a table or a column, the field starting from the one it
 * has. OK hands the name on to Save changes, which shows the script before anything runs.
 */
import { useState } from "react";
import { Field, TextInput } from "../connection-form/form-controls";
import { EditorDialog } from "./editor-dialog";
import { endRename, type RenameRequest } from "./structure-save-store";

export function RenameObjectDialog({ request }: { request: RenameRequest }) {
  const [name, setName] = useState(request.value);
  const [tried, setTried] = useState(false);
  const next = name.trim();
  const problems = next === "" ? ["Type the new name"] : [];
  const unchanged = next === request.value;

  const confirm = () => {
    setTried(true);
    if (problems.length > 0 || unchanged) return;
    endRename();
    request.onConfirm(next);
  };

  return (
    <EditorDialog
      title="Rename object"
      description={`A new name for ${request.value}`}
      onClose={endRename}
      onSubmit={confirm}
      problems={tried ? problems : []}
      buttons={[
        { label: "OK", onClick: confirm, variant: "default", disabled: unchanged },
        { label: "Close", onClick: endRename },
      ]}
    >
      <Field label="New name" htmlFor="rename-object-name">
        <TextInput
          id="rename-object-name" value={name} mono autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
    </EditorDialog>
  );
}
