/**
 * Import a `.ppm-schedule.json`. The file is checked by the rules the server applies again;
 * then the whole code is shown, the inputs are filled in, and the import waits for the person
 * to say they have read the code and trust it. What it creates is always turned off.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Upload } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import { secretPatch, valuePatch } from "@/lib/schedule-form-model";
import { nextFires } from "../../../../shared/schedule-cron";
import { parseScheduleTemplate, type ScheduleTemplate } from "../../../../shared/schedule-template";
import { Field } from "./schedule-kind-fields";
import { ScheduleInputValues } from "./schedule-input-values";
import { serverProblems } from "./schedule-form";
import { ScheduleSheet } from "./schedule-sheet";

const ScheduleScriptEditor = lazy(() => import("./schedule-script-editor").then((m) => ({ default: m.ScheduleScriptEditor })));

/** A template is a few KB; a script may be up to 1 MB. Anything far past that is not one. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const NATIVE_SELECT = "h-11 md:h-9 w-full rounded-md border border-input bg-transparent px-2 text-xs";

interface Project { name: string; path: string }

export function ScheduleImportSheet({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [template, setTemplate] = useState<ScheduleTemplate | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectName, setProjectName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [trusted, setTrusted] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTemplate(null);
    setErrors([]);
    setValues({});
    setSecrets({});
    setTrusted(false);
    api.get<Project[]>("/api/projects").then((list) => {
      setProjects(list);
      setProjectName(list[0]?.name ?? "");
    }).catch(() => setProjects([]));
  }, [open]);

  const decls = template?.inputs ?? [];
  const fires = useMemo(() => (template?.cron ? nextFires(template.cron, 3) : []), [template]);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) { setErrors([`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB; a template is far smaller`]); return; }
    const parsed = parseScheduleTemplate(await file.text());
    setTemplate(parsed.ok ? parsed.template : null);
    setErrors(parsed.ok ? [] : parsed.errors);
  };

  const submit = async () => {
    if (!template) return;
    setSaving(true);
    setErrors([]);
    try {
      const inputValues = Object.fromEntries(Object.entries(valuePatch(decls, values)).filter(([, v]) => v !== null));
      await api.post("/api/schedules/import", { template, projectName, inputValues, secrets: secretPatch(decls, secrets), trust: trusted });
      toast.success(`Imported "${template.name}"`, { description: "It is turned off. Turn it on when you are ready." });
      onImported();
      onClose();
    } catch (e) {
      setErrors(serverProblems(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScheduleSheet open={open} onClose={onClose} title={template ? `Import: ${template.name}` : "Import template"} wide={!!template}>
      <div className="space-y-3 px-1">
        <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
        {!template && (
          <>
            <p className="text-xs text-muted-foreground">Pick a <span className="font-mono">.ppm-schedule.json</span> file. You will see all of its code before anything is created.</p>
            <Button type="button" variant="outline" onClick={() => fileInput.current?.click()} className="w-full min-h-11 gap-1 cursor-pointer">
              <Upload className="size-4" /> {errors.length ? "Choose another file" : "Choose a template file"}
            </Button>
          </>
        )}
        {template && (
          <>
            {template.description && <p className="text-xs text-muted-foreground whitespace-pre-wrap">{template.description}</p>}
            <p className="text-[11px] text-muted-foreground">
              {template.kind === "script" ? `Script · ${template.mode === "always-on" ? "always on" : "tick"}` : "Prompt"}
              {template.cron && <> · <span className="font-mono">{template.cron}</span></>}
              {fires.length > 0 && ` · next ${fires.map((d) => d.toLocaleString()).join(" · ")}`}
            </p>
            <Field label={template.kind === "script" ? "Code (read it all before you trust it)" : "Prompt"}>
              {template.kind === "script" ? (
                <Suspense fallback={<p className="text-[11px] text-muted-foreground py-2">Loading code…</p>}>
                  <ScheduleScriptEditor value={template.script ?? ""} readOnly title={template.name} />
                </Suspense>
              ) : (
                <pre className="max-h-64 overflow-auto rounded-md border border-border p-2 text-[11px] whitespace-pre-wrap break-all">{template.prompt}</pre>
              )}
            </Field>
            {decls.length > 0 && (
              <Field label="Inputs">
                <ScheduleInputValues
                  decls={decls}
                  values={values}
                  secrets={secrets}
                  onValue={(k, v) => setValues((s) => ({ ...s, [k]: v }))}
                  onSecret={(k, v) => setSecrets((s) => ({ ...s, [k]: v }))}
                />
              </Field>
            )}
            <Field label="Project">
              <select aria-label="Project" value={projectName} onChange={(e) => setProjectName(e.target.value)} className={NATIVE_SELECT}>
                {projects.map((p) => <option key={p.path} value={p.name}>{p.name}</option>)}
              </select>
            </Field>
            <label className="flex items-start gap-3 min-h-11 py-2 text-xs cursor-pointer">
              <input type="checkbox" checked={trusted} onChange={(e) => setTrusted(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-primary" />
              <span>I have read this code and trust it to run on this machine</span>
            </label>
          </>
        )}
        {errors.length > 0 && (
          <ul className="space-y-0.5 text-[11px] text-error">
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
        {template && (
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" onClick={() => fileInput.current?.click()} className="min-h-11 cursor-pointer">Other file</Button>
            <Button type="button" onClick={submit} disabled={!trusted || !projectName || saving} className="min-h-11 cursor-pointer">
              {saving ? "Importing…" : "Import (disabled)"}
            </Button>
          </div>
        )}
      </div>
    </ScheduleSheet>
  );
}
