import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, mount, click } from "../../helpers/react-dom";
installDom();
afterAll(() => uninstallDom());
const { act } = await import("react");
const { TerminalLoginCallbackBar, shouldSuggestFinishLogin, useLoginCallbackBar } =
  await import("../../../src/web/components/terminal/terminal-login-callback-bar");
const { describeCallbackInput, describeDeliveryResult } =
  await import("../../../src/web/components/terminal/terminal-finish-login");

const SSO_LINK =
  "https://oidc.us-east-1.amazonaws.com/authorize?response_type=code&client_id=x" +
  "&redirect_uri=http%3A%2F%2F127.0.0.1%3A54132%2Foauth%2Fcallback&state=s";

/** Enough of xterm for the bar: it listens for parsed writes and reads URLs back. */
function fakeTerminal() {
  const listeners: Array<() => void> = [];
  return {
    terminal: {
      onWriteParsed(cb: () => void) {
        listeners.push(cb);
        return { dispose: () => listeners.splice(listeners.indexOf(cb), 1) };
      },
    } as unknown as import("@xterm/xterm").Terminal,
    listeners,
  };
}

describe("describeCallbackInput", () => {
  it("shows the address it will send when it had to fix the paste", () => {
    expect(describeCallbackInput("127.0.0.1:54132/oauth/callback?code=c")).toEqual({
      kind: "ready",
      url: "http://127.0.0.1:54132/oauth/callback?code=c",
      rewritten: true,
    });
    expect(describeCallbackInput("http://127.0.0.1:54132/cb")).toEqual({
      kind: "ready",
      url: "http://127.0.0.1:54132/cb",
      rewritten: false,
    });
  });

  it("does not point out the slash the parser adds to a bare host", () => {
    expect(describeCallbackInput("http://127.0.0.1:54132")).toMatchObject({ kind: "ready", rewritten: false });
  });

  it("explains a refusal and stays quiet when empty", () => {
    expect(describeCallbackInput("  ")).toEqual({ kind: "empty" });
    const bad = describeCallbackInput("localhost.evil.com:8400/cb");
    expect(bad.kind).toBe("invalid");
  });
});

describe("shouldSuggestFinishLogin", () => {
  it("offers the field when a sign-in link waits on a loopback port and PPM is reached remotely", () => {
    expect(shouldSuggestFinishLogin(["54132"], null, "ppm.example.com")).toBe(true);
    expect(shouldSuggestFinishLogin(["54132"], null, "192.168.1.20")).toBe(true);
  });

  it("stays out of the way on the PPM machine, with no link, or once closed for those ports", () => {
    expect(shouldSuggestFinishLogin(["54132"], null, "localhost")).toBe(false);
    expect(shouldSuggestFinishLogin(["54132"], null, "127.0.0.1")).toBe(false);
    expect(shouldSuggestFinishLogin([], null, "ppm.example.com")).toBe(false);
    expect(shouldSuggestFinishLogin(["54132"], "54132", "ppm.example.com")).toBe(false);
    // A new login on another port is offered again.
    expect(shouldSuggestFinishLogin(["54133"], "54132", "ppm.example.com")).toBe(true);
  });
});

describe("describeDeliveryResult", () => {
  it("counts the listener's own refusal as a failed login", () => {
    expect(describeDeliveryResult({ status: 200, body: "You can close this window." })).toEqual({ ok: true });
    expect(describeDeliveryResult({ status: 302, body: "" })).toEqual({ ok: true });
    const refused = describeDeliveryResult({ status: 400, body: "<h1>Error</h1>\n<p>state mismatch</p>" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain("400: Error state mismatch");
  });
});

/** The terminal tab's wiring, without the terminal: the status-bar button and the bar. */
function Harness(props: { terminal: import("@xterm/xterm").Terminal; urls: () => string[] }) {
  const bar = useLoginCallbackBar(props.terminal, props.urls, { pageHostname: "ppm.example.com" });
  return (
    <div>
      <button aria-label="Login callback" aria-pressed={bar.visible} onClick={bar.toggle} />
      <TerminalLoginCallbackBar bar={bar} />
    </div>
  );
}

const region = (c: Element) => c.querySelector('[aria-label="Finish a login"]');

describe("TerminalLoginCallbackBar", () => {
  it("appears by itself when the terminal prints a loopback sign-in link, and closes for good", async () => {
    const { terminal } = fakeTerminal();
    const view = await mount(<Harness terminal={terminal} urls={() => [SSO_LINK]} />);
    expect(region(view.container)?.textContent).toContain("port 54132");
    expect(view.container.querySelector('input[aria-label="Callback address"]')).not.toBeNull();

    await click(view.container.querySelector('button[aria-label="Close"]'));
    expect(region(view.container)).toBeNull();
    await view.unmount();
  });

  it("lets the status-bar button close an offer it did not open, and reports what shows", async () => {
    const { terminal } = fakeTerminal();
    const view = await mount(<Harness terminal={terminal} urls={() => [SSO_LINK]} />);
    const button = view.container.querySelector('button[aria-label="Login callback"]');
    expect(button?.getAttribute("aria-pressed")).toBe("true");
    await click(button);
    expect(region(view.container)).toBeNull();
    expect(button?.getAttribute("aria-pressed")).toBe("false");
    // And opens it again on request, even for the ports it was closed for.
    await click(button);
    expect(region(view.container)).not.toBeNull();
    await view.unmount();
  });

  it("is hidden until asked when nothing in the terminal needs it", async () => {
    const { terminal } = fakeTerminal();
    const view = await mount(<Harness terminal={terminal} urls={() => []} />);
    expect(region(view.container)).toBeNull();
    await click(view.container.querySelector('button[aria-label="Login callback"]'));
    expect(view.container.textContent).toContain("Finish a login started in this terminal");
    await view.unmount();
  });

  it("notices a link printed after it mounted, even while output keeps coming", async () => {
    const { terminal, listeners } = fakeTerminal();
    const urls: string[] = [];
    const view = await mount(<Harness terminal={terminal} urls={() => urls} />);
    expect(region(view.container)).toBeNull();
    urls.push(SSO_LINK);
    await act(async () => {
      // Writes every 100 ms for 1.5 s: a debounce would never fire, a throttle does.
      for (let i = 0; i < 15; i++) {
        for (const l of listeners) l();
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    expect(region(view.container)?.textContent).toContain("port 54132");
    await view.unmount();
  });
});
