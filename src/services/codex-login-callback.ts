import { createServer } from "node:net";

export interface BrowserLoginCallback {
  redirectUri: string;
  state: string;
  submitted: boolean;
}

/** Codex may cancel an existing listener on its preferred port when starting.
 * Refuse an occupied port instead of interrupting another application's login. */
export async function checkCodexLoginPort(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error("Codex login port 1455 is busy. Finish the other browser login or use device code.")));
    server.listen(1455, "127.0.0.1", () => server.close(() => resolve()));
  });
}

export function parseBrowserLogin(authUrl: string): BrowserLoginCallback {
  const auth = new URL(authUrl);
  if (auth.protocol !== "https:" || !["auth.openai.com", "chatgpt.com"].includes(auth.hostname) || auth.username || auth.password) {
    throw new Error("Codex returned an unsupported login URL.");
  }
  const redirect = new URL(auth.searchParams.get("redirect_uri") ?? "");
  if (redirect.protocol !== "http:" || redirect.hostname !== "localhost" || !["1455", "1457"].includes(redirect.port)
    || redirect.pathname !== "/auth/callback" || redirect.search || redirect.hash || redirect.username || redirect.password) {
    throw new Error("Codex returned an unsupported callback URL.");
  }
  const state = auth.searchParams.get("state");
  if (!state) throw new Error("Codex returned a login URL without state.");
  return { redirectUri: redirect.href, state, submitted: false };
}

/** Never fetch the user-supplied URL. Validate it against this pending login,
 * then rebuild a request to the fixed loopback listener using only code/state. */
export function buildCodexCallback(callbackUrl: string, login: BrowserLoginCallback): URL {
  if (typeof callbackUrl !== "string" || callbackUrl.length > 16_384) throw new Error("Paste the full localhost callback URL.");
  let url: URL;
  try { url = new URL(callbackUrl.trim()); } catch { throw new Error("Paste the full localhost callback URL."); }
  const expected = new URL(login.redirectUri);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash) {
    throw new Error("Use the localhost callback URL from this Codex login.");
  }
  const state = url.searchParams.get("state");
  // Codex also accepts this exact onboarding suffix; it still binds to the original state.
  if (url.searchParams.getAll("state").length !== 1 || (state !== login.state && state !== `${login.state}.onboarding_entrypoint=life_sciences`)) {
    throw new Error("This URL belongs to a different login. Use the latest sign-in link.");
  }
  const code = url.searchParams.get("code");
  if (url.searchParams.has("error") || !code || url.searchParams.getAll("code").length !== 1) {
    throw new Error("This URL has no authorization code. Complete ChatGPT sign-in first.");
  }
  expected.hostname = "127.0.0.1";
  expected.searchParams.set("code", code);
  expected.searchParams.set("state", state!);
  return expected;
}

/**
 * Codex accepts the authorization callback, then redirects to its own loopback
 * success endpoint with the exchanged id token. Follow exactly that endpoint
 * while keeping the TCP connection on 127.0.0.1.
 */
export function buildCodexSuccessCallback(location: string, login: BrowserLoginCallback): URL {
  let redirect: URL;
  try { redirect = new URL(location); } catch { throw new Error("Codex returned an invalid callback redirect."); }
  const expected = new URL(login.redirectUri);
  if (redirect.protocol !== "http:" || redirect.hostname !== "localhost" || redirect.port !== expected.port
    || redirect.pathname !== "/success" || redirect.username || redirect.password || redirect.hash
    || redirect.searchParams.getAll("id_token").length !== 1) {
    throw new Error("Codex returned an unsupported callback redirect.");
  }
  redirect.hostname = "127.0.0.1";
  return redirect;
}
