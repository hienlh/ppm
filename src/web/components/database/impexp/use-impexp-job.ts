/**
 * The job Run starts on the server, followed while it runs: each row's progress, the messages —
 * asking only for those not seen yet — and the files it wrote, at most once a second. The tab keeps
 * the job's id, so a reload follows the same job again; closing the tab leaves it running to its end.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api-client";
import { triggerDownload } from "@/lib/file-download";
import { IMPEXP_POLL_MS, type ImpExpJobStarted, type ImpExpJobStatus, type ImpExpMessage } from "../../../../shared/db-impexp";
import { gridExportDownloadUrl, type GridExportTicket } from "../../../../shared/db-grid-export";
import { startingStatus, type ImpExpJobRef } from "./impexp-state";

export interface ImpExpJob {
  /** How the job stands; null before the first Run, or once the server has let go of it. */
  status: ImpExpJobStatus | null;
  /** The log: this run's messages, after those of earlier runs that Preserve Logs kept. */
  messages: ImpExpMessage[];
  /** A job is being started, or is running. */
  busy: boolean;
  start: (url: string, body: unknown, kind: ImpExpJobRef["kind"], rows: string[], preserveLogs: boolean) => Promise<void>;
  stop: () => void;
  download: (name: string) => void;
}

const jobUrl = (id: string, path = "") => `/api/db/impexp/jobs/${encodeURIComponent(id)}${path}`;

export function useImpExpJob(job: ImpExpJobRef | null, onJob: (job: ImpExpJobRef | null) => void): ImpExpJob {
  const [status, setStatus] = useState<ImpExpJobStatus | null>(null);
  const [earlier, setEarlier] = useState<ImpExpMessage[]>([]);
  const [current, setCurrent] = useState<ImpExpMessage[]>([]);
  const [starting, setStarting] = useState(false);
  const onJobRef = useRef(onJob);
  onJobRef.current = onJob;
  const currentRef = useRef(current);
  currentRef.current = current;
  /** The job whose answers may land: one that answers after another was started is dropped. */
  const followed = useRef<string | null>(job?.id ?? null);

  const id = job?.id ?? null;
  useEffect(() => {
    if (!id) return;
    followed.current = id;
    const ctrl = new AbortController();
    let since = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const s = await api.get<ImpExpJobStatus>(jobUrl(id, `?since=${since}`), { signal: ctrl.signal });
        if (ctrl.signal.aborted || followed.current !== id) return;
        since = s.messageCount;
        setStatus(s);
        if (s.messages.length) setCurrent((m) => [...m, ...s.messages]);
        if (s.state === "running") timer = setTimeout(tick, IMPEXP_POLL_MS);
      } catch (e) {
        if (ctrl.signal.aborted || followed.current !== id) return;
        if (e instanceof ApiError && e.status === 404) {
          // Let go of on the server: an hour after it ended, or when PPM restarted.
          setStatus(null);
          setCurrent((m) => [...m, { level: "warning", text: e.message, time: Date.now() }]);
          onJobRef.current(null);
          return;
        }
        // The connection to PPM dropped for a moment: ask again, a little later.
        timer = setTimeout(tick, IMPEXP_POLL_MS * 2);
      }
    };
    void tick();
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [id]);

  const start = useCallback(async (url: string, body: unknown, kind: ImpExpJobRef["kind"], rows: string[], preserveLogs: boolean) => {
    setStarting(true);
    try {
      const { jobId } = await api.post<ImpExpJobStarted>(url, body);
      followed.current = jobId;
      const kept = currentRef.current;
      setEarlier((e) => (preserveLogs ? [...e, ...kept] : []));
      setCurrent([]);
      setStatus(startingStatus(jobId, kind, rows, Date.now()));
      onJobRef.current({ id: jobId, kind, rows });
    } catch (e) {
      toast.error(kind === "export" ? "The export did not start" : "The import did not start", { description: (e as Error).message });
    } finally {
      setStarting(false);
    }
  }, []);

  const stop = useCallback(() => {
    const jobId = followed.current;
    if (!jobId) return;
    api.post<ImpExpJobStatus>(jobUrl(jobId, "/stop"))
      .then((s) => { if (followed.current === jobId) setStatus(s); })
      .catch((e: Error) => toast.error("Could not stop the job", { description: e.message }));
  }, []);

  const download = useCallback((name: string) => {
    const jobId = followed.current;
    if (!jobId) return;
    api.post<GridExportTicket>(jobUrl(jobId, "/download"), { name })
      .then((t) => triggerDownload(gridExportDownloadUrl(t.ticket), t.fileName))
      .catch((e: Error) => toast.error(`Could not download ${name}`, { description: e.message }));
  }, []);

  return {
    status,
    messages: earlier.length ? [...earlier, ...current] : current,
    busy: starting || status?.state === "running",
    start, stop, download,
  };
}
