/**
 * Permission-mode precedence for <ExtensionComposer>, kept in its own module so it
 * can be unit-tested without importing the component (which pulls in browser-only
 * stores). Same precedence a chat tab uses (chat-tab.tsx): an explicit
 * `permissionMode` from the extension wins, otherwise the user's configured
 * provider default, and only then `bypassPermissions`.
 *
 * The composer used to hardcode `bypassPermissions`, so a user who deliberately
 * picked `default`/`acceptEdits` silently got the widest mode — and this value is
 * what the extension hands back to the headless turn endpoint, i.e. what the turn
 * actually runs with.
 */
export function resolveComposerPermissionMode(
  optionMode: string | undefined,
  settings?: { default_provider?: string; providers?: Record<string, { permission_mode?: string } | undefined> },
): string {
  if (optionMode) return optionMode;
  const provider = settings?.providers?.[settings.default_provider ?? "claude"];
  return provider?.permission_mode ?? "bypassPermissions";
}
