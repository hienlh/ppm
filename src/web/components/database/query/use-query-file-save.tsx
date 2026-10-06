/**
 * Save for a Query tab (see `query-file.ts`): Ctrl+S or the toolbar's Save. A tab with no file yet
 * asks for a name and a folder — the editor's own Save As — and, when that folder already has a
 * file by the name, whether to replace it; one with a file writes it again with no question.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { fileDisplayName } from "@/lib/db-tabs";
import { useKeybindingsStore } from "@/stores/keybindings-store";
import { usePanelStore } from "@/stores/panel-store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SaveAsDialog } from "@/components/editor/save-as-dialog";
import { defaultQueryFileName, hasFileNamed, splitFilePath, withSqlExtension } from "./query-file";

/** Whether `path` names a file already there; a folder that cannot be read says nothing, and the write tells. */
async function fileExists(path: string): Promise<boolean> {
  const { dir, name } = splitFilePath(path);
  if (!dir) return false;
  try {
    const listing = await api.get<{ entries: { name: string; type: string }[] }>(`/api/fs/browse?path=${encodeURIComponent(dir)}&showHidden=true`);
    return hasFileNamed(listing.entries, name);
  } catch {
    return false;
  }
}

/** The tab is the one in front, where the user works: its keys are its own. */
function inFront(tabId: string): boolean {
  const s = usePanelStore.getState();
  return s.panels[s.focusedPanelId]?.activeTabId === tabId;
}

export function useQueryFileSave({ tabId, keys, title, savedPath, sql, onSaved }: {
  tabId: string | undefined;
  /** Ctrl+S saves while the tab is in front; a phone has no keys. */
  keys: boolean;
  /** The tab's title, which the first save offers as the file's name. */
  title: string;
  savedPath: string | null;
  /** The SQL as it is now: read when the file is written, not when Save was pressed. */
  sql: () => string;
  /** Written: `path` holds `text`. */
  onSaved: (path: string, text: string) => void;
}): { save: () => void; dialogs: ReactNode } {
  const [asking, setAsking] = useState(false);
  const [replacing, setReplacing] = useState<string | null>(null);

  const write = useCallback(async (path: string) => {
    const text = sql();
    try {
      await api.put("/api/fs/write", { path, content: text });
    } catch (e) {
      toast.error(`Could not save ${fileDisplayName(path)}: ${(e as Error).message}`);
      return;
    }
    onSaved(path, text);
  }, [sql, onSaved]);

  const save = useCallback(() => {
    if (savedPath) void write(savedPath);
    else setAsking(true);
  }, [savedPath, write]);

  const chosen = useCallback(async (picked: string) => {
    setAsking(false);
    const path = withSqlExtension(picked);
    if (await fileExists(path)) setReplacing(path);
    else void write(path);
  }, [write]);

  // Ctrl+S anywhere in the tab — after a result grid with edited rows, which saves those instead.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!keys || !tabId) return;
    const onKey = (e: WindowEventMap["keydown"]) => {
      if (e.repeat || !useKeybindingsStore.getState().matchesEvent(e, "save-prevent") || !inFront(tabId)) return;
      // A dialog open over the tab has the keyboard, the Save As one included.
      if ((e.target as Element | null)?.closest?.('[role="dialog"], [role="alertdialog"]')) return;
      e.preventDefault();
      saveRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keys, tabId]);

  const dialogs = (
    <>
      {asking && (
        <SaveAsDialog
          open defaultName={defaultQueryFileName(title)} content=""
          onSave={(path) => void chosen(path)} onCancel={() => setAsking(false)}
        />
      )}
      {replacing && (
        <Dialog open onOpenChange={(open) => { if (!open) setReplacing(null); }}>
          <DialogContent role="alertdialog" className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Replace file?</DialogTitle>
              <DialogDescription>
                {fileDisplayName(replacing)} is already in that folder. Replacing it writes this tab's SQL over what it holds.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setReplacing(null)} autoFocus>Cancel</Button>
              <Button variant="destructive" onClick={() => { const path = replacing; setReplacing(null); void write(path); }}>Replace</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );

  return { save, dialogs };
}
