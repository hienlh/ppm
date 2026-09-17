/**
 * All user-facing strings for the named-tunnel setup flow, kept in one file so
 * a future i18n pass has a single place to swap. English, like the rest of the
 * PPM interface.
 */
export const namedTunnelCopy = {
  askDomain: {
    title: "Do you have a domain on Cloudflare?",
    body: "With your own domain, PPM can keep one fixed address that survives restarts. Without one, everything still works through a temporary link.",
    yes: "Yes",
    no: "Not yet",
  },
  noDomain: {
    title: "No problem",
    body: "PPM will keep using a temporary link (quick tunnel). You can turn this on later from Tunnel Manager.",
    close: "Close",
  },
  login: {
    title: "Sign in to Cloudflare",
    hint: "Open the link below to sign in — a phone works just as well.",
    finishOnPhone: "You can finish this step on your phone if that is easier.",
    copy: "Copy",
    copied: "Copied",
    open: "Open link",
    waiting: "Waiting for sign-in…",
    slowTitle: "Still signing in?",
    slowBody: "Cloudflare sometimes takes a few minutes. The process is still running — keep waiting or cancel.",
    keepWaiting: "Keep waiting",
    cancel: "Cancel",
  },
  timeout: {
    title: "Sign-in link expired",
    body: "The link expires after 5 minutes unused. Press Retry to get a fresh one.",
    retry: "Retry",
  },
  cancelled: {
    title: "Sign-in cancelled",
    body: "You cancelled the Cloudflare sign-in.",
    retry: "Retry",
  },
  confirmZone: {
    title: "Confirm your zone",
    body: (zone: string) => `This machine will get a fixed address under ${zone}. Continue?`,
    confirm: "Continue",
    startOver: "Start over",
  },
  needsRelogin: {
    title: "Cloudflare sign-in needed",
    certInvalid: "Your Cloudflare sign-in is no longer valid.",
    certMismatch: "This certificate belongs to a different Cloudflare account — sign in again.",
    action: "Sign in again",
  },
  hostname: {
    title: "Choose the address",
    prefixLabel: "Prefix",
    suffixHint: "The suffix is fixed by the account you just signed in with.",
    submit: "Confirm",
  },
  applying: {
    title: "Setting up…",
  },
  done: {
    title: "All set",
    body: (hostname: string) => `Fixed address: https://${hostname}`,
    close: "Close",
  },
  pending: {
    title: "Saved — waiting to apply",
    restartHint: "Run `ppm restart` to apply it now.",
    close: "Close",
  },
  error: {
    title: "Something went wrong",
    retry: "Retry",
    relogin: "Sign in again",
    close: "Close",
  },
  section: {
    title: "Named Tunnel",
    modeQuick: "quick",
    modeNamed: "named",
    hostnameLabel: "Address",
    tokenLabel: "Token",
    setup: "Set up named tunnel",
    retry: "Retry",
    relogin: "Sign in again",
    disable: "Switch back to quick tunnel",
    disableConfirm: "Press again to confirm",
    disableSelfCut:
      "You are viewing PPM through this very domain — turning it off cuts this page immediately and you would never see the temporary link. Open PPM on your local network first, then turn it off.",
    certInvalid: "Cloudflare sign-in needed",
    certMismatch: "Certificate belongs to a different Cloudflare account — sign in again",
    authDisabled: "Enable PPM authentication to use your own domain",
    /** Small note next to the live-mode badge when the configured mode hasn't landed yet. */
    configuredAs: (mode: "quick" | "named") => `configured: ${mode}`,
  },
} as const;
