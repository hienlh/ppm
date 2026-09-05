/**
 * Prefix input + locked zone suffix for the hostname step. The suffix is
 * plain text (not editable) — the zone is pinned by the Cloudflare account
 * the user just logged into, not something a text field should let them
 * casually rewrite.
 */
import { useEffect, useRef } from "react";
import { namedTunnelCopy } from "./named-tunnel-copy";

interface Props {
  zone: string;
  prefix: string;
  error?: string;
  onChange: (prefix: string) => void;
}

export function NamedTunnelHostnameField({ zone, prefix, error, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus on mount, as the spec asks — this component only mounts once
  // per hostname step, so an effect with no deps is exactly "on mount".
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="space-y-1.5">
      <label htmlFor="named-tunnel-prefix" className="block text-sm font-medium text-foreground">
        {namedTunnelCopy.hostname.prefixLabel}
      </label>
      <div className="flex items-stretch rounded-lg border border-border bg-background focus-within:border-primary/50 transition-colors overflow-hidden">
        <input
          ref={inputRef}
          id="named-tunnel-prefix"
          type="text"
          value={prefix}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="min-w-0 flex-1 px-3 py-3 bg-transparent text-sm text-foreground outline-none"
        />
        <span className="flex items-center px-3 py-3 text-sm text-text-subtle bg-surface-elevated border-l border-border select-none whitespace-nowrap">
          .{zone}
        </span>
      </div>
      <p className="text-xs text-text-subtle">{namedTunnelCopy.hostname.suffixHint}</p>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
