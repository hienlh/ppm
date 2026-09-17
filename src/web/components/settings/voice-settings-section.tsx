/**
 * Voice Input settings: which engine the chat mic uses, and the install button
 * for the one that runs on the host.
 *
 * "Whisper on this host" only becomes selectable once it is actually installed
 * — offering an engine that answers 409 would be a setting that silently does
 * nothing. Until then this pane is the install screen for it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Mic, Loader2, Download, Trash2, Check } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useSettingsStore, type VoiceEngine } from "@/stores/settings-store";

interface StatusModel {
  id: string;
  label: string;
  note: string;
  bytes: number;
}

interface InstallJob {
  modelId: string;
  phase: "binary" | "model" | "vad" | "verify";
  receivedBytes: number;
  totalBytes: number;
  done: boolean;
  error: string | null;
}

interface SpeechStatus {
  installable: boolean;
  installHint: string | null;
  binary: { path: string; source: "bundled" | "system" } | null;
  version: string;
  model: StatusModel | null;
  ready: boolean;
  models: StatusModel[];
  install: InstallJob | null;
}

const PHASE_LABEL: Record<InstallJob["phase"], string> = {
  binary: "Downloading whisper.cpp",
  model: "Downloading the model",
  vad: "Downloading the voice detector",
  verify: "Checking it runs here",
};

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

export function VoiceSettingsSection() {
  const voiceEngine = useSettingsStore((s) => s.voiceEngine);
  const setVoiceEngine = useSettingsStore((s) => s.setVoiceEngine);

  const [status, setStatus] = useState<SpeechStatus | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.get<SpeechStatus>("/api/speech/status");
      setStatus(next);
      setSelectedModel((current) => current ?? next.model?.id ?? next.models.at(-1)?.id ?? null);
    } catch {
      // A status that cannot be read leaves the pane on "not installed", which
      // is what the user can act on anyway.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while an install is running — 600 MB takes a while and the phase
  // and byte count are the only sign that anything is happening.
  const installing = !!status?.install && !status.install.done;
  useEffect(() => {
    if (!installing) return;
    pollRef.current = setTimeout(() => void load(), 700);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [installing, status, load]);

  // An engine that was removed must not stay selected.
  useEffect(() => {
    if (status && !status.ready && voiceEngine === "whisper") setVoiceEngine("browser");
  }, [status, voiceEngine, setVoiceEngine]);

  const install = async () => {
    if (!selectedModel) return;
    setBusy(true);
    try {
      await api.post("/api/speech/install", { model: selectedModel });
      await load();
    } catch (e) {
      toast.error("Could not start the install", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const uninstall = async () => {
    setBusy(true);
    try {
      await api.post("/api/speech/uninstall");
      setVoiceEngine("browser");
      await load();
    } catch (e) {
      toast.error("Could not remove Whisper", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const job = status?.install ?? null;
  const percent = job && job.totalBytes > 0 ? Math.round((job.receivedBytes / job.totalBytes) * 100) : null;
  const insecure = typeof window !== "undefined" && !window.isSecureContext;

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Speech to text</h3>
          <p className="text-xs text-muted-foreground">
            What the mic button in the chat box uses. This device only.
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <EngineOption
            label="Browser"
            note="Text appears as you speak. Chrome, Edge and Safari only — the audio goes to their servers."
            value="browser"
            current={voiceEngine}
            onChange={setVoiceEngine}
          />
          {status?.ready && (
            <EngineOption
              label="Whisper on this host"
              note="Works in any browser and the audio never leaves your machine. Text arrives when you stop talking."
              value="whisper"
              current={voiceEngine}
              onChange={setVoiceEngine}
            />
          )}
        </div>
        {insecure && (
          <p className="text-xs text-warning">
            This page is on plain HTTP, where browsers block the microphone entirely. Open PPM over HTTPS or on
            localhost to use either engine.
          </p>
        )}
      </section>

      <Separator />

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Whisper on this host</h3>
          <p className="text-xs text-muted-foreground">
            {status?.ready
              ? `Installed — whisper.cpp ${status.version}, model ${status.model?.label}.`
              : "Runs speech to text on the machine PPM is installed on. Nothing is sent to a cloud service."}
          </p>
        </div>

        {status && !status.installable && (
          <p className="text-xs text-muted-foreground">
            There is no prebuilt whisper.cpp for this platform. Install it yourself and PPM will find it:{" "}
            <code className="rounded bg-muted px-1 py-0.5">{status.installHint ?? "whisper-cli on PATH"}</code>
          </p>
        )}

        {job && !job.done && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              <span>
                {PHASE_LABEL[job.phase]}
                {percent === null ? "…" : ` — ${percent}%`}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-[width]" style={{ width: `${percent ?? 0}%` }} />
            </div>
          </div>
        )}

        {job?.error && <p className="text-xs text-error">{job.error}</p>}

        {status?.installable && (
          <>
            <div className="space-y-2">
              {status.models.map((model) => {
                const active = selectedModel === model.id;
                const installed = status.model?.id === model.id;
                return (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => setSelectedModel(model.id)}
                    className={cn(
                      "w-full rounded-lg border px-4 py-3 text-left transition-colors",
                      active ? "border-primary ring-2 ring-primary" : "border-border hover:bg-muted/50",
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium">{model.label}</span>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        {installed && <Check className="size-3.5 text-success" />}
                        {mb(model.bytes)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">{model.note}</p>
                  </button>
                );
              })}
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <Button
                onClick={install}
                disabled={busy || installing || !selectedModel || status.model?.id === selectedModel}
                className="flex-1 gap-2 cursor-pointer"
              >
                <Download className="size-4" />
                {status.model
                  ? status.model.id === selectedModel
                    ? "Installed"
                    : `Switch to ${status.models.find((m) => m.id === selectedModel)?.label}`
                  : "Install"}
              </Button>
              {(status.model || status.binary?.source === "bundled") && (
                <Button
                  variant="outline"
                  onClick={uninstall}
                  disabled={busy || installing}
                  className="gap-2 cursor-pointer text-error"
                >
                  <Trash2 className="size-4" />
                  Remove
                </Button>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function EngineOption({
  label, note, value, current, onChange,
}: {
  label: string;
  note: string;
  value: VoiceEngine;
  current: VoiceEngine;
  onChange: (engine: VoiceEngine) => void;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onChange(value)}
      className={cn(
        "flex-1 rounded-lg border px-4 py-3 text-left transition-colors",
        active ? "border-primary ring-2 ring-primary" : "border-border hover:bg-muted/50",
      )}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        <Mic className="size-4" />
        {label}
      </span>
      <p className="mt-1 text-xs text-muted-foreground">{note}</p>
    </button>
  );
}
