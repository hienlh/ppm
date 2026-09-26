/**
 * Sign an existing Codex (ChatGPT) account in again, from wherever its "Sign in again" chip
 * is — the Settings pane or the chat's usage panel.
 *
 * Self-contained on purpose: the chat panel has no login state of its own, and giving it a
 * copy of the flow would be the drift the shared account card exists to prevent. It is the
 * add-account dialog in its re-login mode, driven by the same hook, so the server signs the
 * account in inside its own CODEX_HOME and keeps its id, sessions and settings.
 *
 * Mount it only while it is open: the hook loads the account list on mount.
 */

import { CodexAddAccountDialog } from "./codex-add-account-dialog";
import { useCodexAccounts } from "./use-codex-accounts";

export function CodexSignInAgainDialog({ account, onClose, onDone }: {
  account: { id: string; label: string };
  onClose: () => void;
  /** Called once the account is signed in again, so the caller can reload what it shows. */
  onDone: () => void;
}) {
  const c = useCodexAccounts(() => { onDone(); onClose(); });
  return (
    <CodexAddAccountDialog
      open
      onOpenChange={(v) => { if (!v) { c.cancelLogin(); onClose(); } }}
      reloginLabel={account.label}
      label={c.label}
      onLabelChange={c.setLabel}
      apiKey=""
      onApiKeyChange={() => {}}
      adding={false}
      onAddApiKey={() => {}}
      deviceWaiting={c.deviceWaiting}
      onStartDevice={() => void c.startDevice(account.id)}
      device={c.device}
      browser={c.browser}
      onStartBrowser={() => void c.startBrowser(account.id)}
      loginStarting={c.loginStarting}
      callbackUrl={c.callbackUrl}
      onCallbackUrlChange={c.setCallbackUrl}
      submittingCallback={c.submittingCallback}
      onSubmitCallback={() => void c.submitCallback()}
      error={c.err}
    />
  );
}
