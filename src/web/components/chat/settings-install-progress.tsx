/**
 * A background install's progress inside the settings card: polls the installer's own status
 * route (the one its Settings pane reads) until the job ends. Whisper and the WebRTC relay only:
 * the other installs finish inside the tool call.
 */
import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";

interface Job { receivedBytes: number; totalBytes: number; done: boolean; error: string | null; phase?: string }
interface Progress { job: Job | null; installed: boolean }

const POLL_MS = 1500;
const mb = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

async function readProgress(component: string): Promise<Progress | null> {
  if (component === "whisper") {
    const s = await api.get<{ install: Job | null; ready: boolean }>("/api/speech/status");
    return { job: s.install, installed: s.ready };
  }
  if (component === "webrtc_relay") {
    const s = await api.get<{ job: Job | null; installed: boolean }>("/api/remote-desktop/relay");
    return { job: s.job, installed: s.installed };
  }
  return null;
}

export function InstallProgress({ component }: { component: string }) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const next = await readProgress(component);
        if (stopped) return;
        setProgress(next);
        if (next?.job && !next.job.done) timer = setTimeout(() => void tick(), POLL_MS);
      } catch {
        if (!stopped) setFailed(true);
      }
    };
    void tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [component]);

  if (failed) return <p className="text-text-subtle">Progress is not available here; Settings shows it.</p>;
  if (!progress) return <p className="text-text-subtle">Reading progress…</p>;
  const job = progress.job;
  if (job?.error) return <p className="text-error" data-install-state="error">The install stopped: {job.error}</p>;
  if (!job || job.done) {
    return <p className={progress.installed ? "text-success" : "text-text-subtle"} data-install-state={progress.installed ? "done" : "idle"}>{progress.installed ? "Installed." : "Not installed."}</p>;
  }
  const pct = job.totalBytes ? Math.min(100, Math.floor((job.receivedBytes / job.totalBytes) * 100)) : 0;
  return (
    <div className="space-y-1" data-install-state="running">
      <div className="text-text">{job.phase ? `${job.phase} · ` : ""}<b>{mb(job.receivedBytes)}</b>{job.totalBytes ? ` of ${mb(job.totalBytes)}` : ""}</div>
      <div className="h-1.5 rounded-full bg-border overflow-hidden"><span className="block h-full bg-primary" style={{ width: `${pct}%` }} /></div>
      <div className="text-text-subtle">You can close this; Telegram and Settings follow it too.</div>
    </div>
  );
}
