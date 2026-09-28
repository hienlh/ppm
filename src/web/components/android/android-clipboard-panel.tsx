/**
 * The device's clipboard, both directions.
 *
 * Typing into a guest works already (`sendText`), so this is not about text entry — it is about
 * the two cases typing cannot reach: getting something *out* of the device (a token an app
 * printed, a deep link) and putting something in that the guest's own keyboard cannot produce.
 *
 * Nothing here is logged, on either side. The plan's Phase 3 gate says so explicitly, and the
 * server route says so again where it would be easiest to slip.
 */
import { useCallback, useState } from "react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Check, Clipboard, Loader2, Upload } from "@/lib/icons";

export interface AndroidClipboardPanelProps {
  deviceId: string;
}

export function AndroidClipboardPanel({ deviceId }: AndroidClipboardPanelProps) {
  const [fromDevice, setFromDevice] = useState<string | null>(null);
  const [toDevice, setToDevice] = useState("");
  const [busy, setBusy] = useState<"read" | "write" | null>(null);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(async () => {
    setBusy("read"); setError(null);
    try {
      const res = await api.get<{ text: string }>(`/api/android/devices/${encodeURIComponent(deviceId)}/clipboard`);
      setFromDevice(res.text);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [deviceId]);

  const write = useCallback(async () => {
    setBusy("write"); setError(null);
    try {
      await api.post(`/api/android/devices/${encodeURIComponent(deviceId)}/clipboard`, { text: toDevice });
      setSent(true);
      setTimeout(() => setSent(false), 1500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [deviceId, toDevice]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-3">
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="flex-1 text-sm font-medium">From the device</h3>
          <Button variant="secondary" className="h-11 md:h-9" onClick={() => void read()} disabled={busy !== null}>
            {busy === "read" ? <Loader2 className="animate-spin" /> : <Clipboard />} Read
          </Button>
        </div>
        {fromDevice !== null && (
          <textarea
            readOnly
            value={fromDevice}
            rows={3}
            placeholder="(the device's clipboard is empty)"
            className="w-full resize-y rounded-md border bg-muted/40 p-2 font-mono text-xs"
          />
        )}
      </section>

      <section className="flex flex-col gap-2 border-t pt-3">
        <h3 className="text-sm font-medium">To the device</h3>
        <textarea
          value={toDevice}
          onChange={(e) => setToDevice(e.target.value)}
          rows={3}
          placeholder="Text to put on the device's clipboard"
          className="w-full resize-y rounded-md border bg-background p-2 font-mono text-xs"
        />
        <Button className="h-11 self-start md:h-9" onClick={() => void write()}
          disabled={busy !== null || toDevice.length === 0}>
          {sent ? <Check /> : busy === "write" ? <Loader2 className="animate-spin" /> : <Upload />}
          {sent ? "Sent" : "Send to device"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Paste it in the guest with a long press, or with the keyboard's paste key.
        </p>
      </section>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
