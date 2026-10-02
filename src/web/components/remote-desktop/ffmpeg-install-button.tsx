import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { Loader2 } from "@/lib/icons";

interface InstallStatus {
  state: "idle" | "installing" | "installed" | "error";
  error?: string;
}

/** The host owns the installation, so closing this panel does not cancel it. */
export function FfmpegInstallButton({ label }: { label: string }) {
  const [status, setStatus] = useState<InstallStatus>({ state: "idle" });
  const generation = useRef(0);
  const [submitting, setSubmitting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      const current = generation.current;
      try {
        const next = await api.get<InstallStatus>("/api/remote-desktop/requirements/ffmpeg/install");
        if (!cancelled && current === generation.current) { setStatus(next); setRequestError(null); }
      } catch (e) {
        if (!cancelled && current === generation.current) setRequestError((e as Error).message);
      } finally { inFlight = false; }
    };
    void refresh();
    const timer = setInterval(refresh, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const install = async () => {
    generation.current++;
    setSubmitting(true);
    setRequestError(null);
    try {
      const next = await api.post<InstallStatus>("/api/remote-desktop/requirements/ffmpeg/install");
      generation.current++;
      setStatus(next);
    } catch (e) { setRequestError((e as Error).message); }
    finally { setSubmitting(false); }
  };
  const busy = submitting || status.state === "installing";
  return (
    <div className="flex flex-col gap-2">
      <button type="button" disabled={busy || status.state === "installed"}
        onClick={() => void install()}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-white/10 px-3 text-sm hover:bg-white/20 disabled:opacity-50">
        {busy && <Loader2 className="size-4 animate-spin" />}
        {busy ? "Installing ffmpeg…" : status.state === "installed" ? "Installed — checking…" : label}
      </button>
      {busy && <p role="status" className="text-xs text-white/70">Installing on the host. You can close this panel and return later.</p>}
      {(requestError || status.error) && <p role="alert" className="text-sm text-red-300">{requestError || status.error}</p>}
    </div>
  );
}
