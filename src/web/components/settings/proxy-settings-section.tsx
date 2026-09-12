import { useState, useEffect } from "react";
import { Copy, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { getProxySettings, updateProxySettings, getAISettings, type ProxySettings } from "@/lib/api-settings";
import { copyToClipboard } from "@/lib/clipboard";
import { ProxyTestButton } from "./proxy-test-section";
import { proxyEndpoints } from "@/lib/proxy-endpoints";

export function ProxySettingsSection() {
  /** Provider the connection info targets; "" is the unscoped Claude path. */
  const [provider, setProvider] = useState("");
  /** Providers reachable as agents, minus the internal mock. */
  const [agentProviders, setAgentProviders] = useState<string[]>([]);

  useEffect(() => {
    getAISettings()
      .then((s) => setAgentProviders(Object.keys(s.providers ?? {}).filter((id) => id !== "mock" && id !== "claude")))
      .catch(() => setAgentProviders([]));
  }, []);

  const [settings, setSettings] = useState<ProxySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    getProxySettings()
      .then(setSettings)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const update = async (params: Parameters<typeof updateProxySettings>[0]) => {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateProxySettings(params);
      setSettings(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = (text: string, label: string) => {
    void copyToClipboard(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  if (loading || !settings) {
    return (
      <div className="space-y-2">
        <h3 className="text-xs font-medium text-text-secondary">API Proxy</h3>
        <p className="text-[11px] text-text-subtle">{error ? `Error: ${error}` : "Loading..."}</p>
      </div>
    );
  }

  const hasKey = !!settings.authKey;
  const hasTunnel = !!settings.tunnelUrl;
  // Local endpoint from server (actual port), NOT window.location which may be tunnel
  const localEndpoint = settings.localEndpoint;
  const localBaseUrl = localEndpoint.replace(/\/proxy\/v1\/messages$/, "");

  // Every URL below comes from the shared helper, which the Test dialog also
  // uses — that is what keeps the card and the request it fires in agreement.
  const ep = proxyEndpoints(hasTunnel ? settings.tunnelUrl! : localBaseUrl, provider);
  const anthropicEndpoint = ep.anthropicMessages;
  const openAiEndpoint = ep.openAiChatCompletions;
  const anthropicEnv = `ANTHROPIC_BASE_URL=${ep.anthropicBase}\nANTHROPIC_API_KEY=${settings.authKey}`;
  const openAiEnv = `OPENAI_BASE_URL=${ep.openAiBase}\nOPENAI_API_KEY=${settings.authKey}`;

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <p className="text-[11px] text-muted-foreground">
          Expose your Claude accounts as an Anthropic-compatible API endpoint.
          External tools (OpenCode, Cursor, etc.) can use your accounts via this proxy.
        </p>
      </div>

      {/* Enable/Disable toggle */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label className="text-xs">Enable Proxy</Label>
          <p className="text-[11px] text-muted-foreground">
            Accept API requests on /proxy/v1/messages
          </p>
        </div>
        <Switch
          checked={settings.enabled}
          onCheckedChange={(checked) => update({ enabled: checked })}
          disabled={saving}
        />
      </div>

      {/* Auth Key */}
      <div className="space-y-1.5">
        <Label className="text-[11px]">Auth Key</Label>
        {hasKey ? (
          <div className="flex gap-1.5">
            <Input
              readOnly
              value={settings.authKey!}
              className="h-7 text-[11px] font-mono flex-1"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 cursor-pointer shrink-0"
              onClick={() => handleCopy(settings.authKey!, "key")}
            >
              {copied === "key" ? "Copied!" : <Copy className="size-3" />}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 cursor-pointer shrink-0"
              onClick={() => update({ generateKey: true })}
              disabled={saving}
            >
              <RefreshCw className="size-3" />
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs cursor-pointer"
            onClick={() => update({ generateKey: true })}
            disabled={saving}
          >
            Generate Auth Key
          </Button>
        )}
        <p className="text-[10px] text-muted-foreground">
          Use as Bearer token or x-api-key when calling the proxy.
        </p>
      </div>

      {/* Endpoint info */}
      {settings.enabled && hasKey && (
        <div className="space-y-2 rounded-md border p-3 bg-muted/30">
          <div className="flex items-center justify-between">
            <h4 className="text-[11px] font-medium">Connection Info</h4>
            <ProxyTestButton authKey={settings.authKey!} baseUrl={window.location.origin} provider={provider} />
          </div>

          {/* Target provider — the only thing that differs between the two
              dialects below, so both are derived from one prefix. */}
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Provider</Label>
            <div className="flex flex-wrap gap-1.5">
              {[{ id: "", label: "Claude (default)" }, ...agentProviders.map((id) => ({ id, label: id }))].map((p) => (
                <button
                  key={p.id || "default"}
                  type="button"
                  onClick={() => setProvider(p.id)}
                  className={`text-[10px] px-2.5 min-h-[36px] rounded-md border transition-colors cursor-pointer ${
                    provider === p.id ? "border-primary bg-primary/15" : "border-border bg-muted/40 hover:bg-muted"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {provider && (
              <p className="text-[10px] text-muted-foreground">
                Runs the {provider} agent per request (read-only sandbox, one turn). Slower than the default path.
              </p>
            )}
          </div>

          {/* Anthropic endpoint */}
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Anthropic Endpoint</Label>
            <div className="flex gap-1.5 items-center">
              <code className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded flex-1 truncate">
                {anthropicEndpoint}
              </code>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 cursor-pointer shrink-0"
                onClick={() => handleCopy(anthropicEndpoint, "anthropic")}
              >
                {copied === "anthropic" ? "Copied!" : <Copy className="size-3" />}
              </Button>
            </div>
          </div>

          {/* OpenAI endpoint */}
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">OpenAI-Compatible Endpoint</Label>
            <div className="flex gap-1.5 items-center">
              <code className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded flex-1 truncate">
                {openAiEndpoint}
              </code>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 cursor-pointer shrink-0"
                onClick={() => handleCopy(openAiEndpoint, "openai")}
              >
                {copied === "openai" ? "Copied!" : <Copy className="size-3" />}
              </Button>
            </div>
          </div>

          {/* Images live only under a provider — the unscoped path has no such route. */}
          {ep.imagesGenerations && ep.imagesEdits && (
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">Image Endpoints</Label>
              <code className="block text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded truncate">
                {ep.imagesGenerations}
              </code>
              <code className="block text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded truncate">
                {ep.imagesEdits}
              </code>
            </div>
          )}

          {!hasTunnel && (
            <p className="text-[10px] text-muted-foreground">
              Start a Cloudflare tunnel (Share) to get a public URL.
            </p>
          )}

          {/* Usage examples */}
          <div className="space-y-1 pt-1">
            <Label className="text-[10px] text-muted-foreground">Anthropic Format</Label>
            <div className="relative">
              <pre className="text-[9px] font-mono bg-muted p-2 rounded overflow-x-auto whitespace-pre">{anthropicEnv}</pre>
              <Button
                variant="ghost"
                size="sm"
                className="absolute top-1 right-1 h-5 px-1 cursor-pointer"
                onClick={() => handleCopy(anthropicEnv, "anthropic-env")}
              >
                {copied === "anthropic-env" ? "Copied!" : <Copy className="size-2.5" />}
              </Button>
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">OpenAI Format</Label>
            <div className="relative">
              <pre className="text-[9px] font-mono bg-muted p-2 rounded overflow-x-auto whitespace-pre">{openAiEnv}</pre>
              <Button
                variant="ghost"
                size="sm"
                className="absolute top-1 right-1 h-5 px-1 cursor-pointer"
                onClick={() => handleCopy(openAiEnv, "openai-env")}
              >
                {copied === "openai-env" ? "Copied!" : <Copy className="size-2.5" />}
              </Button>
            </div>
          </div>

          {/* Stats */}
          <div className="flex items-center gap-3 pt-1">
            <span className="text-[10px] text-muted-foreground">
              Requests served: <span className="font-mono">{settings.requestCount}</span>
            </span>
          </div>
        </div>
      )}

      {saving && <p className="text-[11px] text-text-subtle">Saving...</p>}
      {error && <p className="text-[11px] text-error">{error}</p>}
    </div>
  );
}
