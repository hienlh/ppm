/**
 * Step content switch — one card per step. Both the popup shell and the
 * Tunnel Manager section render this, so it never assumes it is inside a
 * dialog or a sheet (no close button of its own; the shell owns dismissal).
 */
import { Loader2, AlertCircle } from "lucide-react";
import type { Step } from "./named-tunnel-step-reducer";
import type { UseNamedTunnelSetup } from "./use-named-tunnel-setup";
import { namedTunnelCopy } from "./named-tunnel-copy";
import { NamedTunnelLoginStep } from "./named-tunnel-login-step";
import { NamedTunnelHostnameField } from "./named-tunnel-hostname-field";

const primaryBtn = "w-full min-h-11 py-3 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:pointer-events-none";
const secondaryBtn = "w-full min-h-11 py-3 rounded-lg border border-border text-sm text-text-secondary hover:bg-surface-elevated transition-colors";

interface Props {
  step: Step;
  t: UseNamedTunnelSetup;
}

export function NamedTunnelSetupContent({ step, t }: Props) {
  switch (step.k) {
    case "hidden":
      return null;

    case "ask-domain": {
      const c = namedTunnelCopy.askDomain;
      return (
        <div className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">{c.title}</h2>
            <p className="mt-1 text-sm text-text-secondary leading-relaxed">{c.body}</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={t.answerNo} className={secondaryBtn}>{c.no}</button>
            <button type="button" onClick={t.answerYes} className={primaryBtn}>{c.yes}</button>
          </div>
        </div>
      );
    }

    case "no-domain": {
      const c = namedTunnelCopy.noDomain;
      return (
        <div className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">{c.title}</h2>
            <p className="mt-1 text-sm text-text-secondary leading-relaxed">{c.body}</p>
          </div>
          <button type="button" onClick={t.close} className={primaryBtn}>{c.close}</button>
        </div>
      );
    }

    case "login-wait":
      return <NamedTunnelLoginStep url={step.url} slow={step.slow} onCancel={t.cancelLogin} />;

    case "login-timeout": {
      const c = namedTunnelCopy.timeout;
      return (
        <div className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">{c.title}</h2>
            <p className="mt-1 text-sm text-text-secondary leading-relaxed">{c.body}</p>
          </div>
          <button type="button" onClick={t.retryLogin} className={primaryBtn}>{c.retry}</button>
        </div>
      );
    }

    case "login-cancelled": {
      const c = namedTunnelCopy.cancelled;
      return (
        <div className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">{c.title}</h2>
            <p className="mt-1 text-sm text-text-secondary leading-relaxed">{c.body}</p>
          </div>
          <button type="button" onClick={t.retryLogin} className={primaryBtn}>{c.retry}</button>
        </div>
      );
    }

    case "confirm-zone": {
      const c = namedTunnelCopy.confirmZone;
      return (
        <div className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">{c.title}</h2>
            <p className="mt-1 text-sm text-text-secondary leading-relaxed">{c.body(step.zone)}</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={t.startOver} className={secondaryBtn}>{c.startOver}</button>
            <button type="button" onClick={t.confirmZone} className={primaryBtn}>{c.confirm}</button>
          </div>
        </div>
      );
    }

    case "needs-relogin": {
      const c = namedTunnelCopy.needsRelogin;
      return (
        <div className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">{c.title}</h2>
            <p className="mt-1 text-sm text-text-secondary leading-relaxed">{step.message}</p>
          </div>
          <button type="button" onClick={t.requestRelogin} className={primaryBtn}>{c.action}</button>
        </div>
      );
    }

    case "choose-hostname": {
      const c = namedTunnelCopy.hostname;
      return (
        <div className="space-y-4">
          <h2 className="text-base font-semibold text-foreground">{c.title}</h2>
          <NamedTunnelHostnameField
            zone={step.zone}
            prefix={step.prefix}
            error={step.error}
            onChange={t.setHostnamePrefix}
          />
          <button
            type="button"
            onClick={t.submitHostname}
            disabled={!step.prefix || !!step.error}
            className={primaryBtn}
          >
            {c.submit}
          </button>
        </div>
      );
    }

    case "applying":
      return (
        <div className="space-y-4 py-4">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Loader2 className="size-4 animate-spin text-primary" />
            {step.message}
          </div>
        </div>
      );

    case "done": {
      const c = namedTunnelCopy.done;
      return (
        <div className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">{c.title}</h2>
            <p className="mt-1 text-sm text-text-secondary break-all">{c.body(step.hostname)}</p>
          </div>
          <button type="button" onClick={t.close} className={primaryBtn}>{c.close}</button>
        </div>
      );
    }

    case "pending": {
      const c = namedTunnelCopy.pending;
      return (
        <div className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">{c.title}</h2>
            <p className="mt-1 text-sm text-text-secondary leading-relaxed">{step.message}</p>
            <p className="mt-2 text-xs font-mono text-text-subtle bg-surface-elevated rounded px-2 py-1.5 inline-block">
              ppm restart
            </p>
          </div>
          <button type="button" onClick={t.close} className={primaryBtn}>{c.close}</button>
        </div>
      );
    }

    case "error": {
      const c = namedTunnelCopy.error;
      return (
        <div className="space-y-4">
          <div className="flex items-start gap-2">
            <AlertCircle className="size-4 text-destructive shrink-0 mt-0.5" />
            <div>
              <h2 className="text-base font-semibold text-foreground">{c.title}</h2>
              <p className="mt-1 text-sm text-text-secondary leading-relaxed">{step.message}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={t.close} className={secondaryBtn}>{c.close}</button>
            <button type="button" onClick={t.retryLogin} className={primaryBtn}>{c.retry}</button>
          </div>
        </div>
      );
    }

    default:
      return null;
  }
}
