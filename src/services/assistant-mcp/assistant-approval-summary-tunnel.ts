import type { ApprovalSummary } from "../../shared/assistant-approval.ts";
import { exactFact, fact } from "./assistant-approval-summary.ts";

/**
 * The approval cards of the tunnel tools. Pure: built from what the tool read back through PPM's
 * routes, never from anything the agent said about its request. Every card says **who** can reach
 * what afterwards, because that is the decision: a Cloudflare forward is open to anyone holding
 * the address with no PPM login in front of it, a Tailscale one only to the user's own devices.
 */

export type ForwardVia = "cloudflare" | "tailscale";

export interface ForwardStartApproval {
  port: number;
  via: ForwardVia;
  /** The tailnet's name (or its MagicDNS suffix) for a Tailscale forward. */
  tailnet?: string | null;
  /** This machine's tailnet name, e.g. `devbox.tail1234.ts.net`, for a Tailscale forward. */
  dnsName?: string | null;
}

export function forwardStartSummary(input: ForwardStartApproval): ApprovalSummary {
  if (input.via === "tailscale") {
    // A tailnet named after its owner's login is an email address, which a card never shows.
    const tailnet = input.tailnet && !input.tailnet.includes("@") ? input.tailnet : "(name unknown)";
    return {
      headline: `Share localhost:${input.port} with the devices on your tailnet ${tailnet}`,
      facts: [
        exactFact("Port", String(input.port)),
        fact("Via", "Tailscale Serve"),
        exactFact("Who can reach it", `Devices signed in to the tailnet ${tailnet}`),
        exactFact("Address", input.dnsName
          ? `https://${input.dnsName}:${input.port}/ (the next free port if Serve already uses ${input.port})`
          : "an https://….ts.net address on this machine"),
      ],
      warning: `Every device on that tailnet can open whatever runs on port ${input.port}; PPM's login does not protect it. It lasts until the forward stops or PPM restarts.`,
    };
  }
  return {
    headline: `Put localhost:${input.port} on the public internet`,
    facts: [
      exactFact("Port", String(input.port)),
      fact("Via", "Cloudflare quick tunnel"),
      fact("Who can reach it", "Anyone who has the address", "warning"),
      fact("Address", "a new random https://….trycloudflare.com address"),
    ],
    warning: `Anyone who gets the address can open whatever runs on port ${input.port}; PPM's login does not protect it. The address is random (https://…trycloudflare.com) and lasts until the forward stops or PPM restarts.`,
  };
}

export interface ForwardStopApproval {
  port: number;
  pid: number;
  via: ForwardVia;
  url: string | null;
}

export function forwardStopSummary(input: ForwardStopApproval): ApprovalSummary {
  return {
    headline: `Stop forwarding localhost:${input.port}`,
    facts: [
      exactFact("Port", String(input.port)),
      fact("Via", input.via === "tailscale" ? "Tailscale Serve" : "Cloudflare quick tunnel"),
      exactFact("Address", input.url ?? "(not known)"),
      exactFact("PID", String(input.pid)),
    ],
    warning: input.via === "tailscale"
      ? "Anyone using that address loses it until the port is forwarded again."
      : "Anyone using that address loses it; a new forward gets a new address.",
  };
}

export interface PublicLinkApproval {
  enabled: boolean;
  /** `quick` (random trycloudflare address) or `named` (the user's own hostname). */
  mode: "quick" | "named";
  /** The named tunnel's hostname, when mode is named. */
  hostname: string | null;
  /** The address serving now, when one is (what switching off takes away). */
  url: string | null;
}

export function publicLinkSummary(input: PublicLinkApproval): ApprovalSummary {
  const address = input.mode === "named" && input.hostname
    ? `https://${input.hostname}`
    : null;
  if (input.enabled) {
    return {
      headline: "Make PPM itself reachable from the internet",
      facts: [
        fact("Mode", input.mode === "named" ? "Named tunnel (your own hostname)" : "Quick tunnel"),
        exactFact("Address", address ?? "a new random https://….trycloudflare.com address"),
        fact("Login", "On"),
        fact("Who can reach it", "Anyone with the address reaches PPM's login page", "warning"),
      ],
      warning: "Anyone with the address reaches PPM's login page; whoever signs in controls this machine's terminals and files.",
    };
  }
  const current = input.url ?? address;
  return {
    headline: `Switch off PPM's public address${current ? ` ${current}` : ""}`,
    facts: [
      fact("Mode", input.mode === "named" ? "Named tunnel (your own hostname)" : "Quick tunnel"),
      exactFact("Address", current ?? "(none serving right now)"),
      fact("Who loses access", "Everyone using PPM through that address", "warning"),
    ],
    warning: "Everyone using PPM through it loses access — you too if that is how you are connected, and Telegram's Open in PPM buttons stop working. Telegram itself keeps working, so you can switch it back on from here (a quick tunnel then gets a new address).",
  };
}
