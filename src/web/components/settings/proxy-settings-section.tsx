import { useState, useEffect } from "react";
import { Copy, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { getProxySettings, updateProxySettings, type ProxySettings } from "@/lib/api-settings";
import { ProxyTestButton } from "./proxy-test-section";

export function ProxySettingsSection() {
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

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
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
              onClick={() => copyToClipboard(settings.authKey!, "key")}
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
            <ProxyTestButton authKey={settings.authKey!} baseUrl={localBaseUrl} />
          </div>

          {/* Local endpoint */}
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Local Endpoint</Label>
            <div className="flex gap-1.5 items-center">
              <code className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded flex-1 truncate">
                {localEndpoint}
              </code>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 cursor-pointer shrink-0"
                onClick={() => copyToClipboard(localEndpoint, "local")}
              >
                {copied === "local" ? "Copied!" : <Copy className="size-3" />}
              </Button>
            </div>
          </div>

          {/* Tunnel endpoint */}
          {hasTunnel && settings.proxyEndpoint && (
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">Public Endpoint (Tunnel)</Label>
              <div className="flex gap-1.5 items-center">
                <code className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded flex-1 truncate">
                  {settings.proxyEndpoint}
                </code>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 cursor-pointer shrink-0"
                  onClick={() => copyToClipboard(settings.proxyEndpoint!, "tunnel")}
                >
                  {copied === "tunnel" ? "Copied!" : <Copy className="size-3" />}
                </Button>
              </div>
            </div>
          )}

          {!hasTunnel && (
            <p className="text-[10px] text-muted-foreground">
              Start a Cloudflare tunnel (Share) to get a public URL.
            </p>
          )}

          {/* Usage example */}
          <div className="space-y-1 pt-1">
            <Label className="text-[10px] text-muted-foreground">Usage Example</Label>
            <div className="relative">
              <pre className="text-[9px] font-mono bg-muted p-2 rounded overflow-x-auto whitespace-pre">
{`# Set as base URL in your tool
ANTHROPIC_BASE_URL=${hasTunnel ? settings.tunnelUrl + "/proxy" : localBaseUrl + "/proxy"}
ANTHROPIC_API_KEY=${settings.authKey}

# Or use curl
curl ${hasTunnel ? settings.proxyEndpoint : localEndpoint} \\
  -H "x-api-key: ${settings.authKey}" \\
  -H "content-type: application/json" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'`}
              </pre>
              <Button
                variant="ghost"
                size="sm"
                className="absolute top-1 right-1 h-5 px-1 cursor-pointer"
                onClick={() => copyToClipboard(
                  `ANTHROPIC_BASE_URL=${hasTunnel ? settings.tunnelUrl + "/proxy" : localBaseUrl + "/proxy"}\nANTHROPIC_API_KEY=${settings.authKey}`,
                  "example",
                )}
              >
                {copied === "example" ? "Copied!" : <Copy className="size-2.5" />}
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
      {error && <p className="text-[11px] text-red-500">{error}</p>}
    </div>
  );
}
