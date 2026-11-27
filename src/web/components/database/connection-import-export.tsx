import { useRef, useState } from "react";
import { MoreVertical, Download, Upload, Clipboard, ClipboardPaste } from "@/lib/icons";
import { copyToClipboard } from "@/lib/clipboard";
import { getAuthToken } from "@/lib/api-client";
import { ConnectionExportPasswordDialog } from "./connection-export-password-dialog";

interface Props {
  /** `ppmPassword` is PPM's own password, typed again: the server refuses the export without it. */
  onExport: (ppmPassword: string) => Promise<{ version: number; exported_at: string; connections: unknown[] }>;
  onImport: (data: { connections: unknown[] }) => Promise<{ imported: number; skipped: number; errors: string[] }>;
}

export function ConnectionImportExport({ onExport, onImport }: Props) {
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Where an export goes once PPM's password is typed; null while no export is being asked for.
  const [askingFor, setAskingFor] = useState<"file" | "clipboard" | null>(null);

  const close = () => setOpen(false);

  type Exported = Awaited<ReturnType<Props["onExport"]>>;

  const saveFile = (data: Exported) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ppm-connections-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyData = async (data: Exported) => {
    const ok = await copyToClipboard(JSON.stringify(data, null, 2));
    alert(ok
      ? `Copied ${data.connections.length} connection(s) to clipboard`
      : "Copy failed — clipboard unavailable");
  };

  const deliver = (target: "file" | "clipboard", data: Exported) => (target === "file" ? saveFile(data) : copyData(data));

  /** With PPM run without a password there is nothing to ask, and the export goes at once. */
  const startExport = (target: "file" | "clipboard") => {
    close();
    if (getAuthToken()) { setAskingFor(target); return; }
    onExport("").then((data) => deliver(target, data)).catch((e) => alert(`Export failed: ${(e as Error).message}`));
  };

  const doImport = async (json: string) => {
    try {
      const data = JSON.parse(json);
      const conns = data.connections ?? data;
      if (!Array.isArray(conns)) { alert("Invalid format: expected connections array"); return; }
      const result = await onImport({ connections: conns });
      let msg = `Imported ${result.imported} connection(s)`;
      if (result.skipped > 0) msg += `, ${result.skipped} skipped`;
      if (result.errors?.length > 0) msg += `\n\nErrors:\n${result.errors.join("\n")}`;
      alert(msg);
    } catch (e) {
      alert(`Import failed: ${(e as Error).message}`);
    }
  };

  const handleImportFile = () => {
    close();
    fileRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => doImport(reader.result as string);
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleImportClipboard = async () => {
    close();
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) { alert("Clipboard is empty"); return; }
      await doImport(text);
    } catch (e) {
      alert(`Clipboard read failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-center size-5 rounded hover:bg-surface-elevated transition-colors text-text-subtle hover:text-foreground max-md:size-11 max-md:-my-3"
        title="Import / Export"
      >
        <MoreVertical className="size-3.5" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div className="absolute right-0 top-full mt-1 z-50 w-44 bg-background border border-border rounded-md shadow-lg py-1 text-xs">
            <button onClick={() => startExport("file")} className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-elevated transition-colors text-left max-md:min-h-11">
              <Download className="size-3" /> Export to file
            </button>
            <button onClick={() => startExport("clipboard")} className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-elevated transition-colors text-left max-md:min-h-11">
              <Clipboard className="size-3" /> Export to clipboard
            </button>
            <p className="px-3 pt-0.5 pb-1 text-[11px] leading-snug text-text-subtle">Includes every saved password, in plain text.</p>
            <div className="border-t border-border my-1" />
            <button onClick={handleImportFile} className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-elevated transition-colors text-left max-md:min-h-11">
              <Upload className="size-3" /> Import from file
            </button>
            <button onClick={handleImportClipboard} className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-elevated transition-colors text-left max-md:min-h-11">
              <ClipboardPaste className="size-3" /> Import from clipboard
            </button>
          </div>
        </>
      )}

      <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={handleFileChange} />

      {askingFor && (
        <ConnectionExportPasswordDialog
          onCancel={() => setAskingFor(null)}
          onConfirm={async (ppmPassword) => {
            const target = askingFor;
            // The fetch fails here on a wrong password, and the dialog shows why; past it, it closes.
            const data = await onExport(ppmPassword);
            setAskingFor(null);
            await deliver(target, data);
          }}
        />
      )}
    </div>
  );
}
