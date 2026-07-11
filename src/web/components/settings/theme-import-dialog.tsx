import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useSettingsStore } from "@/stores/settings-store";

type Mode = "url" | "json" | "upload";

/** Import a VSCode theme via Marketplace/raw URL, pasted JSON, or a .json upload. */
export function ThemeImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const importThemeFrom = useSettingsStore((s) => s.importThemeFrom);
  const setCustomTheme = useSettingsStore((s) => s.setCustomTheme);

  const [mode, setMode] = useState<Mode>("url");
  const [url, setUrl] = useState("");
  const [json, setJson] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = () => { setUrl(""); setJson(""); setName(""); setMode("url"); };

  const submit = async () => {
    const value = mode === "url" ? url.trim() : json.trim();
    if (!value) { toast.error("Nothing to import"); return; }
    setBusy(true);
    try {
      const source = mode === "url" ? "url" : mode === "upload" ? "upload" : "json";
      const created = await importThemeFrom({ source, value, name: name.trim() || undefined });
      toast.success(created.length > 1 ? `Imported ${created.length} themes` : `Imported "${created[0]?.name}"`);
      if (created[0]) setCustomTheme(created[0].id);
      reset();
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message || "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      setJson(await file.text());
      setName(file.name.replace(/\.json$/i, ""));
    } catch {
      toast.error("Could not read file");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Import theme</DialogTitle>
          <DialogDescription className="text-text-3">
            Import a VSCode color theme. Single-mode themes apply to both dark and light.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
          <TabsList className="w-full">
            <TabsTrigger value="url" className="flex-1">URL</TabsTrigger>
            <TabsTrigger value="json" className="flex-1">Paste JSON</TabsTrigger>
            <TabsTrigger value="upload" className="flex-1">Upload</TabsTrigger>
          </TabsList>

          <TabsContent value="url" className="space-y-2 pt-2">
            <Input
              placeholder="https://…/theme.json or Marketplace .vsix URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <p className="text-[11px] text-text-3">Only https URLs; private/internal addresses are blocked.</p>
          </TabsContent>

          <TabsContent value="json" className="pt-2">
            <textarea
              className="w-full h-40 rounded-md border border-border bg-surface p-2 text-xs font-mono text-text focus:outline-none focus:border-ring"
              placeholder='{ "name": "My Theme", "type": "dark", "colors": { … }, "tokenColors": [ … ] }'
              value={json}
              onChange={(e) => setJson(e.target.value)}
            />
          </TabsContent>

          <TabsContent value="upload" className="space-y-2 pt-2">
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => onFile(e.target.files?.[0])}
              className="block w-full text-xs text-text-2 file:mr-3 file:rounded file:border file:border-border file:bg-panel-2 file:px-2 file:py-1 file:text-text"
            />
            {json && <p className="text-[11px] text-success">File loaded ({json.length} chars)</p>}
          </TabsContent>
        </Tabs>

        <Input placeholder="Optional name" value={name} onChange={(e) => setName(e.target.value)} />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Importing…" : "Import"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
