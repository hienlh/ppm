import { useState, useRef, useEffect } from "react";
import { Play, Loader2, FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger,
} from "@/components/ui/dialog";

const DEFAULT_MESSAGE = "Hello! Reply briefly.";
const DEFAULT_MODEL = "claude-sonnet-4-6";

type EndpointFormat = "anthropic" | "openai";

interface ProxyTestDialogProps {
  authKey: string;
  baseUrl: string;
}

export function ProxyTestButton(props: ProxyTestDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-[11px] gap-1.5 cursor-pointer">
          <FlaskConical className="size-3" />
          Test
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">Test Proxy</DialogTitle>
          <DialogDescription className="text-[11px]">
            Send a test request and inspect the raw response.
          </DialogDescription>
        </DialogHeader>
        {open && <ProxyTestForm {...props} />}
      </DialogContent>
    </Dialog>
  );
}

function ProxyTestForm({ authKey, baseUrl }: ProxyTestDialogProps) {
  const [format, setFormat] = useState<EndpointFormat>("anthropic");
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [streaming, setStreaming] = useState(true);
  const [testing, setTesting] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLPreElement>(null);

  useEffect(() => { inputRef.current?.select(); }, []);
  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output]);

  // Clear output when switching format
  const switchFormat = (f: EndpointFormat) => {
    setFormat(f);
    setOutput(null);
    setError(null);
    setElapsed(null);
  };

  const runTest = async () => {
    setTesting(true);
    setOutput(null);
    setError(null);
    setElapsed(null);
    const start = Date.now();

    const isOpenAi = format === "openai";
    const endpoint = isOpenAi
      ? `${baseUrl}/proxy/v1/chat/completions`
      : `${baseUrl}/proxy/v1/messages`;

    const body = JSON.stringify({ model, max_tokens: 256, stream: streaming, messages: [{ role: "user", content: message }] });

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (isOpenAi) {
      headers["Authorization"] = `Bearer ${authKey}`;
    } else {
      headers["x-api-key"] = authKey;
      headers["anthropic-version"] = "2023-06-01";
    }

    try {
      const res = await fetch(endpoint, { method: "POST", headers, body });

      if (!res.ok) {
        const text = await res.text();
        setError(`HTTP ${res.status}: ${text}`);
        setTesting(false);
        setElapsed(Date.now() - start);
        return;
      }

      if (!streaming) {
        // Non-streaming: read full JSON and pretty-print
        const text = await res.text();
        try { setOutput(JSON.stringify(JSON.parse(text), null, 2)); } catch { setOutput(text); }
        setElapsed(Date.now() - start);
      } else {
        // Streaming: read SSE chunks progressively
        const reader = res.body?.getReader();
        if (!reader) { setError("No response body"); setTesting(false); return; }
        const decoder = new TextDecoder();
        let raw = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += decoder.decode(value, { stream: true });
          setOutput(raw);
        }
        setElapsed(Date.now() - start);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTesting(false);
      setElapsed((prev) => prev ?? Date.now() - start);
    }
  };

  return (
    <div className="space-y-3 min-w-0">
      {/* Endpoint format toggle */}
      <div className="space-y-1.5 min-w-0">
        <Label className="text-[11px]">Auth Style</Label>
        <div className="flex gap-1">
          {(["anthropic", "openai"] as const).map((f) => (
            <button
              key={f}
              onClick={() => switchFormat(f)}
              className={`flex-1 h-8 rounded-md text-[11px] font-medium border transition-colors cursor-pointer ${
                format === f
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-muted text-muted-foreground border-transparent hover:bg-muted/80"
              }`}
            >
              {f === "anthropic" ? "Anthropic" : "OpenAI"}
            </button>
          ))}
        </div>
        <p className="text-[9px] text-muted-foreground">
          {format === "anthropic" ? "x-api-key header" : "Authorization: Bearer header"}
        </p>
      </div>

      {/* Model */}
      <div className="space-y-1.5">
        <Label className="text-[11px]">Model</Label>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="h-8 w-full rounded-md border bg-background px-2 text-[11px]"
        >
          <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
          <option value="claude-haiku-4-5-20251001">claude-haiku-4-5</option>
          <option value="claude-opus-4-6">claude-opus-4-6</option>
        </select>
      </div>

      {/* Streaming toggle */}
      <div className="flex items-center justify-between">
        <Label className="text-[11px]">Streaming</Label>
        <div className="flex gap-1">
          {([true, false] as const).map((s) => (
            <button
              key={String(s)}
              onClick={() => setStreaming(s)}
              className={`h-7 px-3 rounded-md text-[11px] font-medium border transition-colors cursor-pointer ${
                streaming === s
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-muted text-muted-foreground border-transparent hover:bg-muted/80"
              }`}
            >
              {s ? "Stream" : "JSON"}
            </button>
          ))}
        </div>
      </div>

      {/* Message + Test button */}
      <div className="space-y-1.5">
        <Label className="text-[11px]">Message</Label>
        <div className="flex gap-1.5">
          <Input
            ref={inputRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Type a test message..."
            className="h-9 text-[11px] flex-1 min-w-0"
            onKeyDown={(e) => { if (e.key === "Enter" && !testing) runTest(); }}
          />
          <Button
            size="sm"
            className="h-9 px-3 cursor-pointer shrink-0"
            onClick={runTest}
            disabled={testing || !message.trim()}
          >
            {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            <span className="ml-1 text-[11px]">{testing ? "..." : "Send"}</span>
          </Button>
        </div>
      </div>

      {/* Raw output */}
      {(output || error) && (
        <div className="space-y-1 min-w-0">
          <div className="flex items-center justify-between">
            <Label className="text-[10px] text-muted-foreground">Raw Response</Label>
            {elapsed != null && (
              <span className="text-[9px] font-mono text-muted-foreground">{(elapsed / 1000).toFixed(1)}s</span>
            )}
          </div>
          {error ? (
            <pre className="text-[9px] font-mono bg-red-500/10 text-red-500 p-2 rounded overflow-auto max-h-52 whitespace-pre-wrap break-all">
              {error}
            </pre>
          ) : (
            <pre
              ref={outputRef}
              className="text-[9px] font-mono bg-muted p-2 rounded overflow-auto max-h-52 whitespace-pre-wrap break-all"
            >
              {output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
