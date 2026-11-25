/**
 * A checklist button that asks the *host* to do something (show a macOS permission prompt, run
 * the Windows helper's task). Some of these take seconds — bringing a Windows session back waits
 * for the helper's answer — so the button shows it is working and then says what happened,
 * instead of leaving the user to guess from the next poll.
 */
import { useState } from "react";
import { Loader2 } from "@/lib/icons";
import type { HostActionResult } from "./use-remote-desktop-readiness";

export function HostActionButton({ className, label, run }: {
  className: string;
  label: string;
  run: () => Promise<HostActionResult | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<HostActionResult | null>(null);

  const onClick = async () => {
    setBusy(true);
    setResult(null);
    try { setResult(await run()); } finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <button type="button" className={`${className} self-start disabled:opacity-50`} disabled={busy} onClick={() => void onClick()}>
        {busy && <Loader2 className="size-3.5 animate-spin" />}
        {label}
      </button>
      {result?.message && (
        <p role={result.ok ? "status" : "alert"} className={`text-xs ${result.ok ? "text-emerald-300" : "text-red-300"}`}>
          {result.message}
        </p>
      )}
    </div>
  );
}
