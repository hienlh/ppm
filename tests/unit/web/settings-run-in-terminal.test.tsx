/**
 * The setup steps PPM cannot take itself — a `sudo`, a Homebrew install — hand their command to a
 * terminal rather than only showing it: what each button types, that root is not given an
 * operator step it does not need, that a dialog gets out of the way first, and that the Voice
 * pane notices Homebrew finishing without being reopened.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { click, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";
import type { TailscaleSettingsState } from "../../../src/shared/tailscale-setup";

// Radix's focus scope, inside every Dialog, watches its content with one.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
const { RUN_IN_TERMINAL_ACK_EVENT, RUN_IN_TERMINAL_EVENT } = await import("../../../src/web/lib/run-in-terminal");
const { TailscaleSetupSteps } = await import("../../../src/web/components/settings/tailscale/tailscale-setup-steps");
const { TailscaleSignInDialog } = await import("../../../src/web/components/settings/tailscale/tailscale-sign-in-dialog");
const { VoiceSettingsSection } = await import("../../../src/web/components/settings/voice-settings-section");

/** Every command typed, claimed the way an on-screen terminal claims one, so no dock tab opens. */
let typed: string[] = [];
const claim = (event: Event) => {
  typed.push((event as CustomEvent<{ command: string }>).detail.command);
  window.dispatchEvent(new Event(RUN_IN_TERMINAL_ACK_EVENT));
};

const realFetch = globalThis.fetch;
let view: Mounted | null = null;
beforeEach(() => {
  typed = [];
  window.addEventListener(RUN_IN_TERMINAL_EVENT, claim);
});
afterEach(async () => {
  window.removeEventListener(RUN_IN_TERMINAL_EVENT, claim);
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
});

function tailscale(over: Partial<TailscaleSettingsState> = {}): TailscaleSettingsState {
  return {
    installed: true, backendState: "NeedsLogin", canManage: true, osUser: "alice", platform: "linux",
    tailnet: null, dnsSuffix: null, magicDns: false, httpsCertificates: false, device: null,
    service: { name: "ppm", url: null, defined: false, approved: false, advertised: false, target: null, pointsAtPpm: false },
    enabled: false, ppmPort: 8080, login: { state: "idle", url: null, message: null }, authEnabled: true,
    ...over,
  };
}

const noop = () => {};
const button = (root: ParentNode, label: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) ?? null;

describe("Tailscale on Linux", () => {
  const steps = (state: TailscaleSettingsState) =>
    mount(<TailscaleSetupSteps state={state} onRefresh={noop} onSignIn={noop} onShowSignIn={noop} />);

  it("installs, and names PPM's user as the operator, with one command", async () => {
    view = await steps(tailscale({ installed: false, backendState: null, canManage: null }));
    await click(button(view.container, "Install in terminal"));
    expect(typed).toEqual(["curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale set --operator=alice"]);
    // The command shown is the command typed.
    expect(view.container.querySelector("pre")?.textContent).toBe(typed[0]);
  });

  it("gives root no operator step: it needs none, and may have no sudo", async () => {
    view = await steps(tailscale({ installed: false, backendState: null, canManage: null, osUser: "root" }));
    await click(button(view.container, "Install in terminal"));
    expect(typed).toEqual(["curl -fsSL https://tailscale.com/install.sh | sh"]);
  });

  it("starts a stopped service the same way", async () => {
    view = await steps(tailscale({ backendState: null, canManage: null }));
    await click(button(view.container, "Start in terminal"));
    expect(typed).toEqual(["sudo systemctl enable --now tailscaled && sudo tailscale set --operator=alice"]);
  });

  it("names the operator on its own when that is all that is missing", async () => {
    view = await steps(tailscale({ canManage: false }));
    await click(button(view.container, "Run in terminal"));
    expect(typed).toEqual(["sudo tailscale set --operator=alice"]);
  });

  it("quotes a user name a shell would rewrite, like a directory user's CORP\\alice", async () => {
    view = await steps(tailscale({ installed: false, backendState: null, canManage: null, osUser: "CORP\\alice" }));
    await click(button(view.container, "Install in terminal"));
    expect(typed).toEqual(["curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale set --operator='CORP\\alice'"]);
  });

  it("keeps the download link on a Mac, where there is nothing to type", async () => {
    view = await steps(tailscale({ installed: false, backendState: null, platform: "darwin" }));
    expect(button(view.container, "Install in terminal")).toBeNull();
    expect(view.container.querySelector('a[href="https://tailscale.com/download/mac"]')).not.toBeNull();
  });

  it("closes the sign-in dialog before typing, since the terminal opens behind it", async () => {
    const order: string[] = [];
    window.addEventListener(RUN_IN_TERMINAL_EVENT, () => order.push("typed"));
    view = await mount(
      <TailscaleSignInDialog
        open
        login={{ state: "needs-operator", url: null, message: null }}
        osUser="alice"
        onRetry={noop}
        onCancel={noop}
        onClose={() => order.push("closed")}
      />,
    );
    await click(button(document.body, "Run in terminal"));
    expect(order).toEqual(["closed", "typed"]);
    expect(typed).toEqual(["sudo tailscale set --operator=alice"]);
  });

  it("quotes the user name in the sign-in dialog's command too", async () => {
    view = await mount(
      <TailscaleSignInDialog
        open
        login={{ state: "needs-operator", url: null, message: null }}
        osUser="o'neil smith"
        onRetry={noop}
        onCancel={noop}
        onClose={noop}
      />,
    );
    await click(button(document.body, "Run in terminal"));
    expect(typed).toEqual(["sudo tailscale set --operator='o'\\''neil smith'"]);
  });
});

describe("Voice on a Mac", () => {
  const status = (installable: boolean) => ({
    installable,
    installHint: installable ? null : "brew install whisper.cpp",
    binary: installable ? { path: "/opt/homebrew/bin/whisper-cli", source: "system" } : null,
    version: "1.8.2",
    model: null,
    ready: false,
    models: [{ id: "small", label: "Small", note: "", bytes: 1 }],
    install: null,
  });

  it("types the Homebrew command, then picks whisper-cli up once it lands", async () => {
    let installed = false;
    let reads = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) !== "/api/speech/status") return new Response("{}", { status: 404 });
      reads++;
      return new Response(JSON.stringify({ ok: true, data: status(installed) }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    view = await mount(<VoiceSettingsSection />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(button(view.container, "Install")).toBeNull();
    await click(button(view.container, "Install with Homebrew"));
    expect(typed).toEqual(["brew install whisper.cpp"]);

    const before = reads;
    installed = true;
    await act(async () => { await new Promise((r) => setTimeout(r, 4300)); });
    expect(reads).toBeGreaterThan(before);
    // whisper-cli is there now, so the pane is the model install screen.
    expect(button(view.container, "Install with Homebrew")).toBeNull();
    expect(button(view.container, "Install")).not.toBeNull();
  }, 10_000);
});
