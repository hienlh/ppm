/**
 * Firebase (Android app): the install's own Firebase project, through which the PPM Android app
 * gets push. Two files from the Firebase console; the service-account key is sent once and never
 * shown again — the server answers only the project and the app's public client config.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Upload } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import { useSettingsChanged } from "@/hooks/use-settings-changed";
import { FCM_ANDROID_PACKAGE, type FcmStatus } from "../../../shared/fcm-status";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function FirebasePushCard() {
  const [status, setStatus] = useState<FcmStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [googleServices, setGoogleServices] = useState("");
  const [serviceAccount, setServiceAccount] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.get<FcmStatus>("/api/notifications/fcm"));
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useSettingsChanged("notifications", () => void load());

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await api.put<FcmStatus>("/api/notifications/fcm", {
        ...(googleServices.trim() ? { googleServices: googleServices.trim() } : {}),
        ...(serviceAccount.trim() ? { serviceAccount: serviceAccount.trim() } : {}),
      });
      setStatus(next);
      setGoogleServices("");
      setServiceAccount("");
      toast.success(`Firebase set up for ${next.projectId ?? "the project"}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    try {
      await api.del("/api/notifications/fcm");
      toast.success("Firebase removed");
    } catch (e) {
      toast.error("Could not remove Firebase", { description: errorText(e) });
    } finally {
      await load();
    }
  };

  const configured = !!status?.configured;
  // Once set up, either file alone replaces the saved one.
  const canSave = configured ? !!(googleServices.trim() || serviceAccount.trim()) : !!(googleServices.trim() && serviceAccount.trim());

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">Firebase (Android app)</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          The PPM Android app gets push through your own Firebase project.{" "}
          {status ? (configured ? <>Set up for project <span className="font-mono">{status.projectId}</span>.</> : "Not set up.") : (loadError ?? "Loading…")}
        </p>
      </div>

      <JsonFileField
        label="google-services.json"
        hint={`Firebase console → Project settings → Your apps → add an Android app with package ${FCM_ANDROID_PACKAGE} → download google-services.json.`}
        saved={configured}
        value={googleServices}
        onChange={(v) => { setGoogleServices(v); setError(null); }}
      />
      <JsonFileField
        label="Service account key"
        hint="Project settings → Service accounts → Generate new private key. It stays on this server and is never shown again."
        saved={configured}
        value={serviceAccount}
        onChange={(v) => { setServiceAccount(v); setError(null); }}
      />

      {error && <p className="break-words text-xs text-error">{error}</p>}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button onClick={() => void save()} disabled={saving || !canSave} className="min-h-11 cursor-pointer md:min-h-9">
          {saving ? "Saving…" : "Save"}
        </Button>
        {configured && (
          <Button variant="outline" onClick={() => void clear()} disabled={saving} className="min-h-11 cursor-pointer md:min-h-9">
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}

function JsonFileField({ label, hint, saved, value, onChange }: {
  label: string;
  hint: string;
  saved: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const fileRef = useRef<HTMLInputElement>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    try {
      onChange(await file.text());
    } catch (e) {
      toast.error(`Could not read ${file.name}`, { description: errorText(e) });
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs text-muted-foreground">{label}</label>
        <Button type="button" variant="ghost" size="sm" className="h-8 cursor-pointer gap-1.5 text-xs" onClick={() => fileRef.current?.click()}>
          <Upload className="size-3.5" />
          Choose file
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      <textarea
        id={id}
        rows={3}
        value={value}
        spellCheck={false}
        autoComplete="off"
        placeholder={saved ? "Saved — paste or choose a file to replace it" : "Paste the file's contents, or choose the file"}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
    </div>
  );
}
