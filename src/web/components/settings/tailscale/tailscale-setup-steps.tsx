/**
 * The setup checklist. Every step is read back from Tailscale rather than ticked by hand,
 * so one done in the admin console turns green on the next reading.
 */
import type { ReactNode } from "react";
import { CheckCircle, Loader2, LogIn, RefreshCw } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CopyableCode, ExternalButton } from "./tailscale-ui";
import {
  currentSetupStep,
  TAILSCALE_ADMIN,
  type TailscaleSettingsState,
  type TailscaleStepId,
} from "../../../../shared/tailscale-setup";

const ORDER: TailscaleStepId[] = ["install", "start", "operator", "sign-in", "dns", "tag", "service"];

const TITLES: Record<TailscaleStepId, string> = {
  install: "Install Tailscale",
  start: "Start Tailscale",
  operator: "Let PPM manage Tailscale",
  "sign-in": "Sign in to Tailscale",
  dns: "Turn on MagicDNS and HTTPS",
  tag: "Tag this machine",
  service: "Create the service",
};

const DOWNLOAD: Record<string, string> = {
  darwin: "https://tailscale.com/download/mac",
  win32: "https://tailscale.com/download/windows",
};
const LINUX_INSTALL = "curl -fsSL https://tailscale.com/install.sh | sh";
/** Suggested for a machine with no tag yet; an existing tag is used where one is needed. */
const SUGGESTED_TAG = "tag:ppm";

const tagOwnersSnippet = (tag: string) => `"tagOwners": {\n  "${tag}": ["autogroup:admin"]\n}`;

type StepStatus = "done" | "current" | "todo";

interface Props {
  state: TailscaleSettingsState;
  onRefresh: () => void;
  onSignIn: () => void;
  onShowSignIn: () => void;
}

export function TailscaleSetupSteps({ state, onRefresh, onSignIn, onShowSignIn }: Props) {
  const current = currentSetupStep(state);
  const currentAt = current ? ORDER.indexOf(current) : ORDER.length;
  const visible = ORDER.filter((id) =>
    id === "start" ? current === "start" : id === "operator" ? state.platform === "linux" : true);
  const statusOf = (id: TailscaleStepId): StepStatus =>
    ORDER.indexOf(id) < currentAt ? "done" : id === current ? "current" : "todo";

  const checkAgain = (
    <Button variant="outline" onClick={onRefresh} className="min-h-11 cursor-pointer md:min-h-9">
      <RefreshCw className="size-3.5" />Check again
    </Button>
  );
  const device = state.device?.name || "this machine";
  const name = state.service.name;

  const content: Record<TailscaleStepId, () => ReactNode> = {
    install: () => state.platform === "linux" ? (
      <>
        <Text>Run this on the machine PPM runs on (a PPM terminal works):</Text>
        <CopyableCode code={LINUX_INSTALL} />
        <Actions>{checkAgain}</Actions>
      </>
    ) : (
      <>
        <Text>Install the Tailscale app on the machine PPM runs on and open it once.</Text>
        <Actions>
          <ExternalButton href={DOWNLOAD[state.platform] ?? "https://tailscale.com/download"}>Download Tailscale</ExternalButton>
          {checkAgain}
        </Actions>
      </>
    ),
    start: () => state.platform === "linux" ? (
      <>
        <Text>Tailscale is installed, but its service is not running. Start it:</Text>
        <CopyableCode code="sudo systemctl enable --now tailscaled" />
        <Actions>{checkAgain}</Actions>
      </>
    ) : (
      <>
        <Text>Tailscale is installed, but not running. Open the Tailscale app on this machine.</Text>
        <Actions>{checkAgain}</Actions>
      </>
    ),
    operator: () => (
      <>
        <Text>
          On Linux, Tailscale only takes changes from root and from one user it trusts. PPM runs
          as <Code>{state.osUser}</Code>; run this once:
        </Text>
        <CopyableCode code={`sudo tailscale set --operator=${state.osUser}`} />
        <Actions>{checkAgain}</Actions>
      </>
    ),
    "sign-in": () => {
      if (state.login.state === "starting" || state.login.state === "waiting") {
        return (
          <>
            <Text>Waiting for you to finish signing in.</Text>
            <Actions><Button onClick={onShowSignIn} className="min-h-11 cursor-pointer md:min-h-9">Show sign-in link</Button></Actions>
          </>
        );
      }
      if (state.backendState === "NeedsMachineAuth") {
        return (
          <>
            <Text>Signed in. An admin has to approve {device} before it joins the tailnet.</Text>
            <Actions><ExternalButton href={TAILSCALE_ADMIN.machines}>Open machines</ExternalButton>{checkAgain}</Actions>
          </>
        );
      }
      if (state.backendState === "Starting") {
        return <Text><Loader2 className="mr-2 inline size-4 animate-spin" />Connecting to Tailscale…</Text>;
      }
      const off = state.backendState === "Stopped";
      return (
        <>
          <Text>{off ? "Tailscale is turned off on this machine." : "Sign this machine in with the account that owns your tailnet."}</Text>
          <Actions>
            <Button onClick={onSignIn} className="min-h-11 cursor-pointer md:min-h-9">
              <LogIn className="size-4" />{off ? "Turn on" : "Sign in"}
            </Button>
          </Actions>
        </>
      );
    },
    dns: () => (
      <>
        <Text>
          In <b>DNS</b>, turn on <b>MagicDNS</b>, then choose <b>Enable HTTPS</b> under HTTPS
          Certificates. Every .ts.net address needs both.
        </Text>
        <p className="text-xs text-muted-foreground">
          MagicDNS {state.magicDns ? "on" : "off"} · HTTPS {state.httpsCertificates ? "on" : "off"}
        </p>
        <Actions><ExternalButton href={TAILSCALE_ADMIN.dns}>Open DNS settings</ExternalButton>{checkAgain}</Actions>
      </>
    ),
    tag: () => (
      <>
        <Text>Tailscale only lets a tagged machine host a service.</Text>
        <ol className="list-decimal space-y-3 pl-5 text-sm leading-relaxed text-muted-foreground">
          <li className="space-y-2">
            <p>In <b>Access controls</b>, let admins hand out the tag (once per tailnet):</p>
            <CopyableCode code={tagOwnersSnippet(SUGGESTED_TAG)} />
            <ExternalButton href={TAILSCALE_ADMIN.accessControls}>Open access controls</ExternalButton>
          </li>
          <li className="space-y-2">
            <p>In <b>Machines</b>, open the menu of {device}, choose <b>Edit tags</b> and add <Code>{SUGGESTED_TAG}</Code>.</p>
            <ExternalButton href={TAILSCALE_ADMIN.machines}>Open machines</ExternalButton>
          </li>
        </ol>
        <p className="text-xs leading-relaxed text-muted-foreground">
          A tagged machine belongs to the tag rather than to your account.
        </p>
        <Actions>{checkAgain}</Actions>
      </>
    ),
    service: () => (
      <>
        <Text>
          In <b>Services</b>, choose <b>Advertise</b>, then <b>Define a Service</b>: name
          it <Code>{name}</Code> and give it the port <Code>tcp:443</Code>.
        </Text>
        <p className="text-xs leading-relaxed text-muted-foreground">
          The address can be turned on before this; it then waits for the service and for an admin to approve this machine.
        </p>
        <Actions><ExternalButton href={TAILSCALE_ADMIN.services}>Open services</ExternalButton>{checkAgain}</Actions>
      </>
    ),
  };

  const summary: Partial<Record<TailscaleStepId, string>> = {
    operator: "PPM can change Tailscale's settings.",
    "sign-in": state.device?.dnsName ? `Signed in as ${state.device.dnsName}` : undefined,
    dns: "MagicDNS and HTTPS are on.",
    tag: state.device?.tags.length ? `Tagged ${state.device.tags.join(", ")}` : undefined,
    service: `svc:${name} exists in your tailnet.`,
  };

  return (
    <ol className="space-y-1" data-testid="tailscale-steps">
      {visible.map((id, i) => {
        const status = statusOf(id);
        return (
          <li key={id} className="flex gap-3" data-step={id} data-status={status}>
            <Marker n={i + 1} status={status} />
            <div className="min-w-0 flex-1 space-y-2 pb-4">
              <div className={cn("pt-0.5 text-sm", status === "todo" ? "text-muted-foreground" : "font-medium")}>{TITLES[id]}</div>
              {status === "done" && summary[id] && <p className="text-xs text-muted-foreground">{summary[id]}</p>}
              {status === "current" && content[id]()}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Marker({ n, status }: { n: number; status: StepStatus }) {
  if (status === "done") return <CheckCircle className="mt-0.5 size-5 shrink-0 text-success" />;
  return (
    <span
      className={cn(
        "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium",
        status === "current" ? "border-primary text-primary" : "border-border text-muted-foreground",
      )}
    >
      {n}
    </span>
  );
}

function Text({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>;
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 text-xs text-foreground">{children}</code>;
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>;
}
