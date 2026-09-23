import { useState } from "react";
import { toast } from "sonner";
import { KeyRound, X } from "@/lib/icons";
import { useSettingsStore } from "@/stores/settings-store";
import { McpSignInDialog } from "./mcp-sign-in-dialog";
import { shortMcpServerName } from "./mcp-server-name";

interface McpSignInBarProps {
  /** Servers this chat's Claude subprocess reported as needing a sign-in. */
  needsAuth: string[];
  projectName?: string;
}

/**
 * A strip above the chat input naming the MCP servers that are configured but unusable
 * until someone signs in, each with a button that does it. Without it the only sign of
 * the problem is Claude saying it cannot reach a tool.
 *
 * Hiding it is remembered per server, not per chat: a plugin can ship a dozen connectors
 * nobody means to use, and a bar that returns in every new chat is noise. It shows again
 * only for a server outside the hidden list.
 */
export function McpSignInBar({ needsAuth, projectName }: McpSignInBarProps) {
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const dismissed = useSettingsStore((s) => s.mcpSignInDismissed);
  const dismissMcpSignIn = useSettingsStore((s) => s.dismissMcpSignIn);
  const shown = needsAuth.filter((n) => !dismissed.includes(n));

  const hide = () => {
    dismissMcpSignIn(shown);
    toast.info("Sign-in bar hidden", {
      description: "You can still sign in to these MCP servers from AI Resources → MCP. The bar comes back only for a server that is not on this list.",
    });
  };

  // The dialog stays at the same place in the tree whether or not the bar shows: a
  // successful sign-in empties `needsAuth` while the dialog is still open, and remounting
  // it there would start a second sign-in.
  return (
    <>
      {shown.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-t border-border bg-surface-elevated/60 px-2 py-1.5 text-xs">
          <KeyRound className="size-3.5 shrink-0 text-warning" />
          <span className="shrink-0 text-text-secondary">
            {shown.length === 1 ? "MCP server needs sign-in:" : "MCP servers need sign-in:"}
          </span>
          <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
            {shown.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setSigningIn(name)}
                className="shrink-0 rounded border border-border bg-background px-2.5 py-1.5 font-medium text-text-primary transition-colors hover:bg-surface max-md:min-h-9"
                title={`Sign in to ${name}`}
              >
                {shortMcpServerName(name)}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={hide}
            className="flex size-8 shrink-0 items-center justify-center rounded text-text-secondary transition-colors hover:bg-surface hover:text-text-primary max-md:size-10"
            aria-label="Hide these servers"
            title="Hide these servers"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <McpSignInDialog serverName={signingIn} project={projectName} onClose={() => setSigningIn(null)} />
    </>
  );
}
