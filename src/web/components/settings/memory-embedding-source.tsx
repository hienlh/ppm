/**
 * Settings → Memory → Search by meaning (requirements 9.1–9.4, 11.2): where memories get their
 * meaning (vector) from. Off, the Local model (installed once on request, ≈ 650 MB, with its
 * progress) or an OpenAI-compatible API (always with a warning that memory text leaves the
 * machine; the key is never answered by the server, only `has_api_key`, and an empty key field
 * keeps the stored one). Whenever vectors cannot be used, the block says search runs on words
 * only and why. Below `md` the selector is a 3-column grid of 40px buttons and actions are 44px.
 *
 * `embedding` is `status.embedding` from `GET /api/memory/status`; `onChanged` reloads it.
 * Install progress also arrives as `memory:embed-install` on `window`.
 */
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, Cpu, Download, Globe, Info, Loader2, TriangleAlert, X } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { MEMORY_EMBED_INSTALL_EVENT } from "@/lib/api-memory";
import { cn } from "@/lib/utils";

type Source = "off" | "local" | "api";

type InstallStatus =
  | { state: "not-installed" }
  | { state: "installing"; step: "packages" | "model"; bytes: number; totalBytes: number }
  | { state: "ready" }
  | { state: "failed"; reason: string };

type TestResult = { ok: true; dims: number; ms: number } | { ok: false; error: string };

const INSTALL_PATH = "/api/memory/embedding/install";
const MB = 1024 * 1024;
const LOCAL_MODEL_NAME = "multilingual-e5-small";

const SOURCES: Array<{ id: Source; label: string; Icon?: typeof Cpu }> = [
  { id: "off", label: "Off" },
  { id: "local", label: "Local model", Icon: Cpu },
  { id: "api", label: "API", Icon: Globe },
];

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function asSource(v: unknown): Source {
  return v === "local" || v === "api" ? v : "off";
}

function asInstall(v: unknown): InstallStatus {
  if (typeof v === "object" && v !== null && typeof (v as { state?: unknown }).state === "string") {
    return v as InstallStatus;
  }
  return { state: "not-installed" };
}

function vectorCount(vectors: number, total: number, running: boolean): string {
  const computing = running && vectors < total ? `; ${total - vectors} are being computed.` : ".";
  return `${vectors} of ${total} memories have meanings${computing}`;
}

/** The phone/desktop sizes of the block's action buttons: 44px below md. */
const ACTION = "h-11 md:h-8";
const LINK_ACTION = "h-11 px-2 text-xs text-muted-foreground hover:text-foreground md:h-auto md:px-1";

export function MemoryEmbeddingSource({ embedding, onChanged }: {
  embedding: Record<string, unknown>;
  onChanged: () => void | Promise<void>;
}) {
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const changed = () => { void onChangedRef.current(); };

  const savedSource = asSource(embedding.source);
  const savedUrl = str(embedding.api_url);
  const savedModel = str(embedding.api_model);
  const hasApiKey = embedding.has_api_key === true;
  const ready = embedding.ready === true;
  const reason = str(embedding.reason);
  const vectors = num(embedding.vectors);
  const total = num(embedding.total);
  const running = embedding.running === true;
  const installKey = JSON.stringify(embedding.install ?? null);

  const [source, setSource] = useState<Source>(savedSource);
  const [install, setInstall] = useState<InstallStatus>(() => asInstall(embedding.install));
  const [url, setUrl] = useState(savedUrl);
  const [model, setModel] = useState(savedModel);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<null | "source" | "install" | "remove" | "save" | "test">(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const ids = useId();

  useEffect(() => { setSource(savedSource); }, [savedSource]);
  useEffect(() => { setInstall(asInstall(JSON.parse(installKey))); }, [installKey]);
  useEffect(() => { setUrl(savedUrl); }, [savedUrl]);
  useEffect(() => { setModel(savedModel); }, [savedModel]);

  useEffect(() => {
    const onInstall = (e: Event) => {
      const status = (e as CustomEvent<{ status?: unknown }>).detail?.status;
      if (typeof status !== "object" || status === null) return;
      const next = asInstall(status);
      setInstall(next);
      // Readiness and the reason come from the status route; reload once the install settles.
      if (next.state !== "installing") void onChangedRef.current();
    };
    window.addEventListener(MEMORY_EMBED_INSTALL_EVENT, onInstall);
    return () => window.removeEventListener(MEMORY_EMBED_INSTALL_EVENT, onInstall);
  }, []);

  const choose = async (next: Source) => {
    if (next === source || busy) return;
    // The server refuses an API source with no endpoint; open the form and let Save send it.
    if (next === "api" && !(savedUrl && savedModel)) {
      setSource("api");
      return;
    }
    const previous = source;
    setSource(next);
    setBusy("source");
    try {
      await api.put("/api/memory/settings", { embedding: { source: next } });
      changed();
    } catch (e) {
      setSource(previous);
      toast.error(`Could not save: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const startInstall = async () => {
    setBusy("install");
    try {
      setInstall(asInstall(await api.post(INSTALL_PATH)));
    } catch (e) {
      toast.error(`Could not start the install: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  /** Cancel a running install, or remove the installed model. */
  const removeInstall = async () => {
    setBusy("remove");
    try {
      await api.del(INSTALL_PATH);
      setInstall({ state: "not-installed" });
      changed();
    } catch (e) {
      toast.error(`Could not remove the model: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  /** The API fields as the server takes them; an empty key is left out so the stored one stays. */
  const apiFields = () => {
    const fields: Record<string, string> = { source: "api", api_url: url.trim(), api_model: model.trim() };
    if (apiKey.trim()) fields.api_key = apiKey.trim();
    return fields;
  };

  const save = async () => {
    setBusy("save");
    try {
      await api.put("/api/memory/settings", { embedding: apiFields() });
      setApiKey("");
      changed();
    } catch (e) {
      toast.error(`Could not save: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setTestResult(null);
    try {
      setTestResult(await api.post<TestResult>("/api/memory/embedding/test", apiFields()));
    } catch (e) {
      setTestResult({ ok: false, error: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const wordsOnly = !ready || !!reason;

  return (
    <section className="space-y-3">
      <div>
        <p className="text-sm font-medium">Search by meaning</p>
        <p className="text-xs text-muted-foreground">
          Word search always works. Adding meaning finds a memory worded differently from the question, Vietnamese or English.
        </p>
      </div>

      <div role="group" aria-label="Search by meaning source" className="grid grid-cols-3 rounded-lg border border-border bg-surface p-0.5 md:inline-flex">
        {SOURCES.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            aria-pressed={source === id}
            disabled={busy === "source"}
            onClick={() => void choose(id)}
            className={cn(
              "flex h-10 items-center justify-center gap-1.5 rounded-md text-xs md:h-7 md:px-3",
              source === id ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon && <Icon className="hidden size-3.5 md:block" />}
            {label}
          </button>
        ))}
      </div>

      {source === "local" && (
        <LocalModel
          install={install}
          busy={busy}
          countLine={vectorCount(vectors, total, running)}
          onInstall={() => void startInstall()}
          onRemove={() => void removeInstall()}
        />
      )}

      {source === "api" && (
        <div className="space-y-3">
          <div className="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <p className="text-xs">Every memory's text is sent to this endpoint to compute its meaning, and each search query too.</p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-url`} className="text-xs font-medium">Endpoint URL</label>
            <Input id={`${ids}-url`} value={url} placeholder="https://api.openai.com/v1" onChange={(e) => setUrl(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-model`} className="text-xs font-medium">Model</label>
            <Input id={`${ids}-model`} value={model} placeholder="text-embedding-3-small" onChange={(e) => setModel(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-key`} className="text-xs font-medium">API key</label>
            <Input
              id={`${ids}-key`}
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder={hasApiKey ? "••••••••••••••••" : "Optional"}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button className={ACTION} disabled={!!busy || !url.trim() || !model.trim()} onClick={() => void save()}>
              {busy === "save" && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
            <Button variant="outline" className={ACTION} disabled={!!busy || !url.trim() || !model.trim()} onClick={() => void test()}>
              {busy === "test" && <Loader2 className="size-4 animate-spin" />}
              Test
            </Button>
            {testResult && (testResult.ok
              ? (
                <span className="flex items-center gap-1 text-xs text-success">
                  <Check className="size-3.5 shrink-0" />
                  Works · {testResult.dims.toLocaleString("en-US")} dimensions · {testResult.ms.toLocaleString("en-US")} ms
                </span>
              )
              : (
                <span className="flex min-w-0 items-center gap-1 break-words text-xs text-error">
                  <X className="size-3.5 shrink-0" />
                  {testResult.error}
                </span>
              ))}
          </div>
          {savedSource === "api" && ready && (
            <p className="text-xs text-muted-foreground">{vectorCount(vectors, total, running)}</p>
          )}
        </div>
      )}

      {wordsOnly && (
        <div className="space-y-1 rounded-lg border border-border px-3 py-2.5">
          <p className="flex items-center gap-2 text-sm">
            {source === "off"
              ? <Info className="size-4 shrink-0 text-muted-foreground" />
              : <TriangleAlert className="size-4 shrink-0 text-warning" />}
            Searching by words only
          </p>
          {reason && <p className="break-words text-xs text-muted-foreground">{reason}</p>}
        </div>
      )}

      {source !== "off" && (
        <p className="text-xs text-muted-foreground">
          Switching to another model or source recomputes every memory's meaning in the background. Vectors from two models are never mixed.
        </p>
      )}
    </section>
  );
}

function LocalModel({ install, busy, countLine, onInstall, onRemove }: {
  install: InstallStatus;
  busy: string | null;
  countLine: string;
  onInstall: () => void;
  onRemove: () => void;
}) {
  if (install.state === "ready") {
    return (
      <div className="space-y-1.5 rounded-lg border border-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Check className="size-4 shrink-0 text-success" />
          <p className="min-w-0 flex-1 text-sm">{LOCAL_MODEL_NAME} · runs on this machine</p>
          <button type="button" className={LINK_ACTION} disabled={!!busy} onClick={onRemove}>Remove</button>
        </div>
        <p className="text-xs text-muted-foreground">Nothing leaves this machine. {countLine}</p>
      </div>
    );
  }

  if (install.state === "installing") {
    const totalMb = Math.round(install.totalBytes / MB);
    const doneMb = Math.min(Math.round(install.bytes / MB), totalMb || Infinity);
    const percent = install.totalBytes > 0 ? Math.min(100, Math.round((install.bytes / install.totalBytes) * 100)) : 0;
    return (
      <div className="space-y-2 rounded-lg border border-border px-3 py-3">
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>Installing the model…</span>
          {install.totalBytes > 0 && <span className="text-xs text-muted-foreground">{doneMb} / {totalMb} MB</span>}
        </div>
        <div
          role="progressbar"
          aria-label="Model install progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-1.5 overflow-hidden rounded-full bg-surface"
        >
          <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
        </div>
        <button type="button" className={LINK_ACTION} disabled={busy === "remove"} onClick={onRemove}>Cancel</button>
      </div>
    );
  }

  const failed = install.state === "failed";
  return (
    <div className="space-y-2 rounded-lg border border-border px-3 py-3">
      <p className="text-sm">{failed ? "The model could not be installed." : "The model is not installed."}</p>
      {failed && <p className="break-words text-xs text-error">{install.reason}</p>}
      <p className="text-xs text-muted-foreground">
        {LOCAL_MODEL_NAME} understands Vietnamese and English and runs on the CPU. Download ≈ 650 MB into ~/.ppm once
        (runtime 520 MB + model 130 MB). While it runs it uses about 1 GB of RAM, and it stops after 10 minutes without a search.
      </p>
      <Button className={cn(ACTION, "w-full md:w-auto")} disabled={!!busy} onClick={onInstall}>
        {busy === "install" ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
        {failed ? "Try again" : "Install (≈ 650 MB)"}
      </Button>
    </div>
  );
}
