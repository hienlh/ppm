/**
 * Signing this machine in: `tailscale up` hands back a link, opened here or scanned on a
 * phone. The machine joins once the person finishes in the browser, and the dialog follows
 * the snapshot the server announces. Closing it does not stop the sign-in: the link stays
 * valid, and the checklist offers it again.
 */
import { QRCodeSVG } from "qrcode.react";
import { Loader2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { AdaptiveDialog, CopyableCode, ExternalButton } from "./tailscale-ui";
import { RunInTerminalButton } from "../run-in-terminal-button";
import { operatorCommand } from "./tailscale-setup-steps";
import { TAILSCALE_ADMIN, type TailscaleLoginSnapshot } from "../../../../shared/tailscale-setup";

interface Props {
  open: boolean;
  login: TailscaleLoginSnapshot;
  osUser: string;
  onRetry: () => void;
  onCancel: () => void;
  onClose: () => void;
}

const text = "text-sm leading-relaxed text-muted-foreground";

export function TailscaleSignInDialog({ open, login, osUser, onRetry, onCancel, onClose }: Props) {
  const close = <Button variant="outline" onClick={onClose} className="min-h-11 cursor-pointer md:min-h-9">Close</Button>;
  const retry = <Button onClick={onRetry} className="min-h-11 cursor-pointer md:min-h-9">Try again</Button>;

  let body;
  let actions;
  if (login.state === "waiting" && login.url) {
    body = (
      <>
        <p className={text}>
          Sign in with the account that owns your tailnet. This machine joins as soon as you finish.
        </p>
        <div className="flex flex-col items-center gap-2">
          <div className="rounded-lg p-3" style={{ backgroundColor: "#ffffff", colorScheme: "light" }}>
            <QRCodeSVG value={login.url} size={168} bgColor="#ffffff" fgColor="#000000" level="L" style={{ display: "block" }} />
          </div>
          <p className="text-xs text-muted-foreground">Or scan it with your phone</p>
        </div>
      </>
    );
    actions = (
      <>
        <Button variant="outline" onClick={onCancel} className="min-h-11 cursor-pointer md:min-h-9">Cancel sign-in</Button>
        <ExternalButton href={login.url} primary>Open sign-in page</ExternalButton>
      </>
    );
  } else if (login.state === "idle" || login.state === "starting") {
    body = (
      <p className={`flex items-center gap-2 ${text}`}>
        <Loader2 className="size-4 animate-spin" />Asking Tailscale for a sign-in link…
      </p>
    );
    actions = <Button variant="outline" onClick={onCancel} className="min-h-11 cursor-pointer md:min-h-9">Cancel</Button>;
  } else if (login.state === "success") {
    body = <p className={text}>Signed in.</p>;
    actions = close;
  } else if (login.state === "needs-approval") {
    body = <p className={text}>Signed in. An admin has to approve this machine before it joins the tailnet.</p>;
    actions = <>{close}<ExternalButton href={TAILSCALE_ADMIN.machines} primary>Open machines</ExternalButton></>;
  } else if (login.state === "needs-operator") {
    const command = operatorCommand(osUser);
    body = (
      <>
        <p className={text}>
          Tailscale on this machine only takes changes from root and from one user it trusts. This has
          to be run once, with your password. PPM types it into a terminal; press Enter there, then
          sign in again.
        </p>
        <CopyableCode code={command} />
      </>
    );
    // Closes the dialog on the way: the terminal opens in the dock behind it.
    actions = (
      <>
        {close}
        <Button variant="outline" onClick={onRetry} className="min-h-11 cursor-pointer md:min-h-9">Try again</Button>
        <RunInTerminalButton command={command} label="Run in terminal" onRun={onClose} />
      </>
    );
  } else {
    body = <p className={text}>{login.message ?? "The sign-in was cancelled."}</p>;
    actions = <>{close}{retry}</>;
  }

  return (
    <AdaptiveDialog open={open} title="Sign in to Tailscale" onClose={onClose}>
      <div className="space-y-4" data-testid="tailscale-sign-in">
        {body}
        <div className="flex flex-col-reverse gap-2 pt-2 md:flex-row md:justify-end">{actions}</div>
      </div>
    </AdaptiveDialog>
  );
}
