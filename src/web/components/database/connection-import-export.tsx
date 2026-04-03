import { useRef, useState } from "react";
import { MoreVertical, Download, Upload, Clipboard, ClipboardPaste } from "lucide-react";

interface Props {
  onExport: () => Promise<{ version: number; exported_at: string; connections: unknown[] }>;
  onImport: (data: { connections: unknown[] }) => Promise<{ imported: number; skipped: number; errors: string[] }>;
}

export function ConnectionImportExport({ onExport, onImport }: Props) {
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const close = () => setOpen(false);

  const handleExportFile = async () => {
    close();
    try {
      const data = await onExport();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ppm-connections-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Export failed: ${(e as Error).message}`);
    }
  };

  const handleExportClipboard = async () => {
    close();
    try {
      const data = await onExport();
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      alert(`Copied ${data.connections.length} connection(s) to clipboard`);
    } catch (e) {
      alert(`Export failed: ${(e as Error).message}`);
    }
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
        className="flex items-center justify-center size-5 rounded hover:bg-surface-elevated transition-colors text-text-subtle hover:text-foreground"
        title="Import / Export"
      >
        <MoreVertical className="size-3.5" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div className="absolute right-0 top-full mt-1 z-50 w-44 bg-background border border-border rounded-md shadow-lg py-1 text-xs">
            <button onClick={handleExportFile} className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-elevated transition-colors text-left">
              <Download className="size-3" /> Export to file
            </button>
            <button onClick={handleExportClipboard} className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-elevated transition-colors text-left">
              <Clipboard className="size-3" /> Export to clipboard
            </button>
            <div className="border-t border-border my-1" />
            <button onClick={handleImportFile} className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-elevated transition-colors text-left">
              <Upload className="size-3" /> Import from file
            </button>
            <button onClick={handleImportClipboard} className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-elevated transition-colors text-left">
              <ClipboardPaste className="size-3" /> Import from clipboard
            </button>
          </div>
        </>
      )}

      <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={handleFileChange} />
    </div>
  );
}
