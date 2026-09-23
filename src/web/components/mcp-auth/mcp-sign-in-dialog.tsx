/**
 * Sign in to one MCP server. Shared by the chat's sign-in bar and the AI Resources list.
 * Dialog on desktop, bottom sheet on mobile.
 */
import { useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, TriangleAlert } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useMcpSignInFlow } from "./use-mcp-sign-in-flow";
import { CLAUDE_AI_CONNECTORS_URL, isClaudeAiConnector } from "./claude-ai-connector";

interface McpSignInDialogProps {
  /** Server to sign in to; null keeps the dialog closed. */
  serverName: string | null;
  /** Project whose MCP configuration applies — matters for project-scoped servers. */
  project?: string;
  onClose: () => void;
  onSignedIn?: (serverName: string) => void;
}

export function McpSignInDialog({ serverName, project, onClose, onSignedIn }: McpSignInDialogProps) {
  const isMobile = useIsMobile();
  const open = serverName !== null;
  const title = serverName ? `Sign in to ${serverName}` : "Sign in";
  const connector = serverName !== null && isClaudeAiConnector(serverName);
  // The flow lives here, above the dialog/sheet switch: the two shells are different
  // trees, and crossing the breakpoint mid sign-in (rotating a large phone) would
  // otherwise remount the body, cancel the flow and kill the CLI's callback listener.
  const flow = useMcpSignInFlow(connector ? null : serverName, project, onSignedIn);
  const body = !serverName ? null : connector
    ? <ClaudeAiConnectorBody onClose={onClose} />
    : <SignInBody key={serverName} serverName={serverName} flowState={flow} onClose={onClose} />;

  if (isMobile) {
    return (
      <BottomSheet open={open} onClose={onClose} className="popover-solid">
        <div className="px-4 pb-4 pt-1">
          <h2 className="mb-3 text-base font-semibold">{title}</h2>
          {body}
        </div>
      </BottomSheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Grant PPM's Claude sessions access to this MCP server.</DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}

function SignInBody({ serverName, flowState, onClose }: {
  serverName: string;
  flowState: ReturnType<typeof useMcpSignInFlow>;
  onClose: () => void;
}) {
  const { flow, starting, busy, error, retry, submitCallback, confirm } = flowState;
  const [pasted, setPasted] = useState("");

  if (starting || (!flow && !error)) {
    return <StatusLine icon={<Loader2 className="size-4 animate-spin" />} text="Preparing the sign-in…" />;
  }

  if (!flow || flow.status === "failed" || flow.status === "expired" || flow.status === "cancelled") {
    return (
      <div className="space-y-3">
        <ErrorLine text={flow?.error ?? error ?? "The sign-in did not finish."} />
        <div className="flex gap-2">
          <Button className="h-11 flex-1 md:h-9" onClick={() => void retry()}>Try again</Button>
          <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>Close</Button>
        </div>
      </div>
    );
  }

  if (flow.status === "done") {
    return (
      <div className="space-y-3">
        <StatusLine
          icon={<CheckCircle2 className="size-4 text-success" />}
          text={`Signed in. ${serverName} is available to Claude — open chats reconnect it on their own.`}
        />
        <Button className="h-11 w-full md:h-9" onClick={onClose}>Done</Button>
      </div>
    );
  }

  const shownError = flow.error ?? error;
  return (
    <div className="space-y-4">
      {flow.authUrl && (
        <Button asChild className="h-11 w-full md:h-9">
          {/* A real link, not window.open(): a popup opened after an await is blocked. */}
          <a href={flow.authUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="size-4" /> Open sign-in page
          </a>
        </Button>
      )}

      {flow.callbackExpected ? (
        <StatusLine
          icon={<Loader2 className="size-4 animate-spin" />}
          text={flow.redirectScheme === "custom"
            ? "Waiting for you to approve access. The page returns to PPM by itself."
            : "Waiting for you to approve access in the browser…"}
        />
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-text-secondary">Grant access on the page that opens, then come back here.</p>
          <Button variant="outline" className="h-11 w-full md:h-9" disabled={busy} onClick={() => void confirm()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null} I've granted access
          </Button>
        </div>
      )}

      {flow.callbackExpected && (
        <form
          className="space-y-2 rounded-md border border-border p-3"
          onSubmit={(e) => { e.preventDefault(); if (pasted.trim()) void submitCallback(pasted.trim()); }}
        >
          <p className="text-xs text-text-secondary">
            {flow.redirectScheme === "custom" ? (
              <>Did the page not come back to PPM? Copy the address the browser ended on after approving and paste it here.</>
            ) : (
              <>
                Not on the machine running PPM? After approving, the browser lands on a <code>localhost</code> page
                that does not load. Copy that page's address and paste it here.
              </>
            )}
          </p>
          <div className="flex gap-2">
            <Input
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder={flow.redirectScheme === "custom" ? "https://…/callback?code=…" : "http://localhost:…/callback?code=…"}
              className="h-11 flex-1 md:h-9"
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="submit" variant="outline" className="h-11 md:h-9" disabled={busy || !pasted.trim()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : "Submit"}
            </Button>
          </div>
        </form>
      )}

      {shownError && <ErrorLine text={shownError} />}
    </div>
  );
}

function ClaudeAiConnectorBody({ onClose }: { onClose: () => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">
        This connector belongs to your claude.ai account. Connect it in claude.ai's connector settings,
        then start a new chat to use it here.
      </p>
      <div className="flex gap-2">
        <Button asChild className="h-11 flex-1 md:h-9">
          <a href={CLAUDE_AI_CONNECTORS_URL} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="size-4" /> Open claude.ai connectors
          </a>
        </Button>
        <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}

function StatusLine({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-start gap-2 text-sm text-text-secondary">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span>{text}</span>
    </div>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 text-sm text-error">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-words">{text}</span>
    </div>
  );
}
