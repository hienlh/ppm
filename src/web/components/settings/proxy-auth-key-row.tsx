import { Copy, Eye, RefreshCw } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The proxy's auth key. The server answers only its first characters until this device asks for
 * the whole key (Show), so a pane left open on another screen never shows it. Copy asks for it
 * first when it is not shown yet.
 */
export function ProxyAuthKeyRow({ authKey, revealed, saving, copied, onShow, onCopy, onGenerate }: {
  authKey: string | null;
  revealed: boolean;
  saving: boolean;
  copied: boolean;
  onShow: () => void;
  onCopy: () => void;
  onGenerate: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px]">Auth Key</Label>
      {authKey ? (
        <div className="flex gap-1.5">
          <Input readOnly value={authKey} className="h-7 text-[11px] font-mono flex-1" aria-label="Proxy auth key" />
          {!revealed && (
            <Button variant="outline" size="sm" className="h-7 px-2 cursor-pointer shrink-0" onClick={onShow} aria-label="Show the auth key">
              <Eye className="size-3" />
            </Button>
          )}
          <Button variant="outline" size="sm" className="h-7 px-2 cursor-pointer shrink-0" onClick={onCopy} aria-label="Copy the auth key">
            {copied ? "Copied!" : <Copy className="size-3" />}
          </Button>
          <Button
            variant="outline" size="sm" className="h-7 px-2 cursor-pointer shrink-0"
            onClick={onGenerate} disabled={saving} aria-label="Generate a new auth key"
          >
            <RefreshCw className="size-3" />
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" className="h-7 text-xs cursor-pointer" onClick={onGenerate} disabled={saving}>
          Generate Auth Key
        </Button>
      )}
      <p className="text-[10px] text-muted-foreground">
        Use as Bearer token or x-api-key when calling the proxy.
      </p>
    </div>
  );
}
