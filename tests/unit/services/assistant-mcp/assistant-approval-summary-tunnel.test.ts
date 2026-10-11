import { describe, expect, test } from "bun:test";
import {
  forwardStartSummary, forwardStopSummary, publicLinkSummary,
} from "../../../../src/services/assistant-mcp/assistant-approval-summary-tunnel.ts";
import type { ApprovalSummary } from "../../../../src/shared/assistant-approval.ts";

const factValue = (s: ApprovalSummary, label: string) => s.facts.find((f) => f.label === label)?.value;
const allText = (s: ApprovalSummary) => [s.headline, s.warning ?? "", ...s.facts.map((f) => `${f.label} ${f.value}`)].join("\n");

describe("forwardStartSummary", () => {
  test("a Cloudflare forward says the port goes on the public internet, open to anyone with the address", () => {
    const s = forwardStartSummary({ port: 5173, via: "cloudflare" });
    expect(s.headline).toBe("Put localhost:5173 on the public internet");
    expect(factValue(s, "Who can reach it")).toBe("Anyone who has the address");
    expect(s.facts.find((f) => f.label === "Who can reach it")?.tone).toBe("warning");
    expect(s.warning).toContain("PPM's login does not protect it");
    expect(s.warning).toContain("lasts until the forward stops or PPM restarts");
  });

  test("a Tailscale forward names the tailnet and says only its devices reach it", () => {
    const s = forwardStartSummary({ port: 3000, via: "tailscale", tailnet: "example.org", dnsName: "devbox.tail1234.ts.net" });
    expect(s.headline).toBe("Share localhost:3000 with the devices on your tailnet example.org");
    expect(factValue(s, "Who can reach it")).toBe("Devices signed in to the tailnet example.org");
    expect(factValue(s, "Address")).toStartWith("https://devbox.tail1234.ts.net:3000/");
    expect(allText(s)).not.toContain("public internet");
  });

  test("a tailnet named by an email address never appears on the card", () => {
    const s = forwardStartSummary({ port: 3000, via: "tailscale", tailnet: "someone@gmail.com", dnsName: null });
    expect(allText(s)).not.toContain("@");
    expect(s.headline).toContain("(name unknown)");
  });

  test("a Tailscale card still reads when the tailnet's name is unknown", () => {
    const s = forwardStartSummary({ port: 3000, via: "tailscale", tailnet: null, dnsName: null });
    expect(s.headline).toContain("(name unknown)");
    expect(factValue(s, "Address")).toContain(".ts.net");
  });
});

describe("forwardStopSummary", () => {
  test("names the port, the whole address and the pid, and says the address is lost", () => {
    const url = "https://a-very-long-random-name-that-is-not-cut.trycloudflare.com";
    const s = forwardStopSummary({ port: 5173, pid: 4242, via: "cloudflare", url });
    expect(s.headline).toBe("Stop forwarding localhost:5173");
    expect(factValue(s, "Address")).toBe(url);
    expect(factValue(s, "PID")).toBe("4242");
    expect(s.warning).toBe("Anyone using that address loses it; a new forward gets a new address.");
  });

  test("a Tailscale forward's card does not promise a new address", () => {
    const s = forwardStopSummary({ port: 5173, pid: 9, via: "tailscale", url: "https://devbox.tail1234.ts.net:5173/" });
    expect(s.warning).not.toContain("new address");
    expect(factValue(s, "Via")).toBe("Tailscale Serve");
  });
});

describe("publicLinkSummary", () => {
  test("switching a quick tunnel on says a public address will exist and who reaches the login page", () => {
    const s = publicLinkSummary({ enabled: true, mode: "quick", hostname: null, url: null });
    expect(s.headline).toBe("Make PPM itself reachable from the internet");
    expect(factValue(s, "Address")).toBe("a new random https://….trycloudflare.com address");
    expect(factValue(s, "Login")).toBe("On");
    expect(s.warning).toBe("Anyone with the address reaches PPM's login page; whoever signs in controls this machine's terminals and files.");
  });

  test("switching a named tunnel on shows its own hostname", () => {
    const s = publicLinkSummary({ enabled: true, mode: "named", hostname: "ppm.example.com", url: null });
    expect(factValue(s, "Address")).toBe("https://ppm.example.com");
    expect(factValue(s, "Mode")).toContain("Named");
  });

  test("switching off names the address that goes away and warns about Telegram's buttons", () => {
    const s = publicLinkSummary({ enabled: false, mode: "quick", hostname: null, url: "https://abc.trycloudflare.com" });
    expect(s.headline).toBe("Switch off PPM's public address https://abc.trycloudflare.com");
    expect(factValue(s, "Address")).toBe("https://abc.trycloudflare.com");
    expect(s.warning).toContain("you too if that is how you are connected");
    expect(s.warning).toContain("Telegram's Open in PPM buttons stop working");
    expect(s.warning).toContain("switch it back on from here");
  });

  test("never carries a token or a sign-in link (none is an input)", () => {
    for (const s of [
      publicLinkSummary({ enabled: true, mode: "named", hostname: "ppm.example.com", url: null }),
      publicLinkSummary({ enabled: false, mode: "named", hostname: "ppm.example.com", url: "https://ppm.example.com" }),
    ]) {
      expect(allText(s)).not.toMatch(/token|login\.tailscale|dash\.cloudflare/i);
    }
  });
});
