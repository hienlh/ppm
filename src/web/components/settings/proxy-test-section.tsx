import { useState, useRef, useEffect } from "react";
import { Play, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const DEFAULT_MESSAGE = "Hello! Reply briefly.";
const DEFAULT_MODEL = "claude-sonnet-4-6";

interface ProxyTestSectionProps {
  authKey: string;
  baseUrl: string;
}

export function ProxyTestSection({ authKey, baseUrl }: ProxyTestSectionProps) {
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [testing, setTesting] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLPreElement>(null);

  // Auto-select input text on mount for quick override
  useEffect(() => {
    inputRef.current?.select();
  }, []);

  // Auto-scroll output to bottom
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const runTest = async () => {
    setTesting(true);
    setOutput(null);
    setError(null);
    setElapsed(null);
    const start = Date.now();

    const endpoint = `${baseUrl}/proxy/v1/messages`;
    const body = JSON.stringify({
      model,
      max_tokens: 256,
      stream: true,
      messages: [{ role: "user", content: message }],
    });

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": authKey,
          "anthropic-version": "2023-06-01",
        },
        body,
      });

      if (!res.ok) {
        const text = await res.text();
        setError(`HTTP ${res.status}: ${text}`);
        setTesting(false);
        setElapsed(Date.now() - start);
        return;
      }

      // Read SSE stream and append raw events
      const reader = res.body?.getReader();
      if (!reader) {
        setError("No response body");
        setTesting(false);
        return;
      }

      const decoder = new TextDecoder();
      let raw = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        raw += chunk;
        setOutput(raw);
      }

      setElapsed(Date.now() - start);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTesting(false);
      if (!elapsed) setElapsed(Date.now() - start);
    }
  };

  return (
    <div className="space-y-2 rounded-md border p-3 bg-muted/30">
      <h4 className="text-[11px] font-medium">Test Proxy</h4>

      {/* Model + Message */}
      <div className="space-y-1.5">
        <Label className="text-[10px] text-muted-foreground">Model</Label>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="h-7 w-full rounded-md border bg-background px-2 text-[11px]"
        >
          <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
          <option value="claude-haiku-4-5-20251001">claude-haiku-4-5</option>
          <option value="claude-opus-4-6">claude-opus-4-6</option>
        </select>
      </div>

      <div className="space-y-1.5">
        <Label className="text-[10px] text-muted-foreground">Message</Label>
        <div className="flex gap-1.5">
          <Input
            ref={inputRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Type a test message..."
            className="h-8 text-[11px] flex-1"
            onKeyDown={(e) => { if (e.key === "Enter" && !testing) runTest(); }}
          />
          <Button
            size="sm"
            className="h-8 px-3 cursor-pointer shrink-0"
            onClick={runTest}
            disabled={testing || !message.trim()}
          >
            {testing ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
            <span className="ml-1 text-[11px]">{testing ? "Testing..." : "Test"}</span>
          </Button>
        </div>
      </div>

      {/* Raw output */}
      {(output || error) && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Label className="text-[10px] text-muted-foreground">Raw Response</Label>
            {elapsed != null && (
              <span className="text-[9px] font-mono text-muted-foreground">{(elapsed / 1000).toFixed(1)}s</span>
            )}
          </div>
          {error ? (
            <pre className="text-[9px] font-mono bg-red-500/10 text-red-500 p-2 rounded overflow-auto max-h-48 whitespace-pre-wrap break-all">
              {error}
            </pre>
          ) : (
            <pre
              ref={outputRef}
              className="text-[9px] font-mono bg-muted p-2 rounded overflow-auto max-h-64 whitespace-pre-wrap break-all"
            >
              {output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
