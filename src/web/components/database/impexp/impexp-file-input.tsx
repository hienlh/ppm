/**
 * DBGate's Upload file button and its "Drag & drop imported files here" box. The files go up one
 * at a time, in the order given, and each becomes a row once the server holds it. One that is empty
 * or over the size an upload may be is refused here, without being sent. There is no Add web URL:
 * a server that fetches any address typed into it is a way into the network it runs in.
 */
import { useEffect, useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import { Upload } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { ImportUpload } from "../../../../shared/db-impexp";
import { uploadProblem } from "./impexp-state";
import { uploadImpExpFile } from "./impexp-upload";
import { formButtonClass } from "./impexp-parts";

interface Sending {
  key: number;
  name: string;
  loaded: number;
  total: number;
}

const carriesFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

export function FileInput({ onUploaded }: { onUploaded: (upload: ImportUpload) => void }) {
  const [sending, setSending] = useState<Sending[]>([]);
  const [over, setOver] = useState(false);
  const pickRef = useRef<HTMLInputElement>(null);
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;
  const queue = useRef<Promise<void>>(Promise.resolve());
  const seq = useRef(0);
  // Closing the tab cancels what is still going up.
  const cancel = useRef<AbortController | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    cancel.current = ctrl;
    return () => ctrl.abort();
  }, []);

  const add = (files: readonly File[]) => {
    for (const file of files) {
      const problem = uploadProblem(file);
      if (problem) {
        toast.error(problem);
        continue;
      }
      const key = ++seq.current;
      setSending((s) => [...s, { key, name: file.name, loaded: 0, total: file.size }]);
      queue.current = queue.current.then(async () => {
        const signal = cancel.current?.signal;
        if (!signal || signal.aborted) return;
        try {
          const upload = await uploadImpExpFile(
            file, (p) => setSending((s) => s.map((x) => (x.key === key ? { ...x, loaded: p.loaded } : x))), signal,
          );
          onUploadedRef.current(upload);
        } catch (e) {
          if (!signal.aborted) toast.error(`Could not upload ${file.name}`, { description: (e as Error).message });
        } finally {
          setSending((s) => s.filter((x) => x.key !== key));
        }
      });
    }
  };

  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="flex">
        <button type="button" className={formButtonClass} onClick={() => pickRef.current?.click()}>
          <Upload className="size-3.5" />Upload file
        </button>
        <input
          ref={pickRef} type="file" multiple hidden aria-hidden tabIndex={-1}
          onChange={(e) => {
            add([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>
      <div
        onDragOver={(e) => {
          if (!carriesFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          if (!carriesFiles(e)) return;
          e.preventDefault();
          setOver(false);
          add([...e.dataTransfer.files]);
        }}
        className={cn(
          "rounded-md border border-dashed border-border bg-panel-2 px-3 py-2.5 text-xs text-text-2",
          over && "border-primary bg-surface-hover text-text-primary",
        )}
      >
        Drag & drop imported files here
      </div>
      {sending.map((s, i) => {
        const pct = s.total ? Math.floor((s.loaded / s.total) * 100) : 0;
        return (
          <div key={s.key} className="grid gap-1 text-xs text-text-2" role="status">
            <div className="flex min-w-0 justify-between gap-2">
              <span className="truncate">{s.name}</span>
              <span className="shrink-0 tabular-nums">{i === 0 ? `${pct}%` : "Waiting"}</span>
            </div>
            <div className="h-1 overflow-hidden rounded bg-surface-hover">
              <div className="h-full bg-primary transition-[width]" style={{ width: `${i === 0 ? pct : 0}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
