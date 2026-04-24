import { resolve } from "node:path";
import { hostname } from "node:os";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { VERSION } from "../version.ts";
import { configService } from "./config.service.ts";
import { getPpmDir } from "./ppm-dir.ts";

const authFile = () => resolve(getPpmDir(), "cloud-auth.json");
const deviceFile = () => resolve(getPpmDir(), "cloud-device.json");
const machineIdFile = () => resolve(getPpmDir(), "machine-id");

const DEFAULT_CLOUD_URL = "https://ppm.hienle.tech";
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Types ──────────────────────────────────────────────────────────────

interface CloudAuth {
  access_token: string;
  refresh_token: string;
  email: string;
  cloud_url: string;
  saved_at: string;
}

interface CloudDevice {
  device_id: string;
  secret_key: string;
  name: string;
  machine_id: string;
  cloud_url: string;
  linked_at: string;
}

interface DeviceInfo {
  id: string;
  machineId: string;
  name: string;
  tunnelUrl: string | null;
  version: string | null;
  lastHeartbeat: string | null;
  computedStatus: string;
  createdAt: string;
}

// ─── Machine ID ─────────────────────────────────────────────────────────

/** Get or generate a stable machine ID (random UUID, persists across reboots) */
export function getMachineId(): string {
  if (existsSync(machineIdFile())) {
    return readFileSync(machineIdFile(), "utf-8").trim();
  }
  const id = randomBytes(16).toString("hex");
  ensurePpmDir();
  writeFileSync(machineIdFile(), id);
  return id;
}

// ─── Auth ───────────────────────────────────────────────────────────────

/** Read saved cloud auth credentials */
export function getCloudAuth(): CloudAuth | null {
  try {
    if (!existsSync(authFile())) return null;
    return JSON.parse(readFileSync(authFile(), "utf-8"));
  } catch {
    return null;
  }
}

/** Save cloud auth credentials (restricted permissions) */
export function saveCloudAuth(auth: CloudAuth): void {
  ensurePpmDir();
  writeFileSync(authFile(), JSON.stringify(auth, null, 2));
  try { chmodSync(authFile(), 0o600); } catch {}
}

/** Remove cloud auth credentials */
export function removeCloudAuth(): void {
  try { if (existsSync(authFile())) unlinkSync(authFile()); } catch {}
}

// ─── Device ─────────────────────────────────────────────────────────────

/** Read saved cloud device info */
export function getCloudDevice(): CloudDevice | null {
  try {
    if (!existsSync(deviceFile())) return null;
    return JSON.parse(readFileSync(deviceFile(), "utf-8"));
  } catch {
    return null;
  }
}

/** Save cloud device info (restricted permissions) */
export function saveCloudDevice(device: CloudDevice): void {
  ensurePpmDir();
  writeFileSync(deviceFile(), JSON.stringify(device, null, 2));
  try { chmodSync(deviceFile(), 0o600); } catch {}
}

/** Remove cloud device info */
export function removeCloudDevice(): void {
  try { if (existsSync(deviceFile())) unlinkSync(deviceFile()); } catch {}
}

// ─── API Client ─────────────────────────────────────────────────────────

/** Make authenticated request to cloud API */
async function cloudFetch(
  path: string,
  options: RequestInit = {},
  auth?: CloudAuth,
): Promise<Response> {
  const creds = auth || getCloudAuth();
  if (!creds) throw new Error("Not logged in. Run 'ppm cloud login' first.");

  const url = `${creds.cloud_url}${path}`;
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${creds.access_token}`);
  headers.set("Content-Type", "application/json");

  let res = await fetch(url, { ...options, headers });

  // Auto-refresh if 401
  if (res.status === 401 && creds.refresh_token) {
    const refreshed = await refreshAccessToken(creds);
    if (refreshed) {
      headers.set("Authorization", `Bearer ${refreshed.access_token}`);
      res = await fetch(url, { ...options, headers });
    }
  }

  return res;
}

/** Refresh access token using refresh_token via POST /auth/refresh */
async function refreshAccessToken(auth: CloudAuth): Promise<CloudAuth | null> {
  if (!auth.refresh_token) return null;

  try {
    const res = await fetch(`${auth.cloud_url}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: auth.refresh_token }),
    });

    if (!res.ok) return null;

    const data = await res.json() as {
      ok: boolean;
      access_token?: string;
      refresh_token?: string;
      email?: string;
    };

    if (!data.ok || !data.access_token) return null;

    const refreshed: CloudAuth = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || auth.refresh_token,
      email: data.email || auth.email,
      cloud_url: auth.cloud_url,
      saved_at: new Date().toISOString(),
    };

    saveCloudAuth(refreshed);
    return refreshed;
  } catch {
    return null;
  }
}

// ─── CLI Login ──────────────────────────────────────────────────────────

/**
 * Start a temporary localhost server to catch the OAuth callback.
 * Returns the auth credentials after successful login.
 */
export async function startLoginServer(cloudUrl: string): Promise<CloudAuth> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.stop();
      reject(new Error("Login timed out after 120 seconds"));
    }, 120_000);

    const server = Bun.serve({
      port: 0, // random available port
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/callback") {
          const accessToken = url.searchParams.get("access_token");
          const refreshToken = url.searchParams.get("refresh_token");
          const email = url.searchParams.get("email");

          if (!accessToken || !email) {
            clearTimeout(timeout);
            server.stop();
            reject(new Error("OAuth callback missing required parameters"));
            return new Response(errorHtml("Login failed — missing parameters"), {
              headers: { "Content-Type": "text/html" },
            });
          }

          const auth: CloudAuth = {
            access_token: accessToken,
            refresh_token: refreshToken || "",
            email,
            cloud_url: cloudUrl,
            saved_at: new Date().toISOString(),
          };

          saveCloudAuth(auth);
          clearTimeout(timeout);
          // Delay stop to allow response to be sent
          setTimeout(() => server.stop(), 500);
          resolve(auth);

          return new Response(successHtml(email), {
            headers: { "Content-Type": "text/html" },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    // Open browser with cli_port param
    const loginUrl = `${cloudUrl}/auth/google/login?cli_port=${server.port}`;
    openBrowser(loginUrl);
    console.log(`\n  Waiting for Google login...`);
    console.log(`  If browser didn't open, visit: ${loginUrl}\n`);
  });
}

/**
 * Device code login flow (RFC 8628).
 * Works from PPM terminal, SSH, or any remote session.
 * User enters a short code on ppm.hienle.tech/verify from any browser.
 */
export async function startDeviceCodeLogin(cloudUrl: string): Promise<CloudAuth> {
  // 1. Request device code
  const res = await fetch(`${cloudUrl}/auth/device-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) throw new Error(`Failed to initiate device code: ${res.status}`);

  const data = await res.json() as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };

  // 2. Display code to user
  console.log(`\n  ┌──────────────────────────────────────────┐`);
  console.log(`  │  Visit: ${data.verification_uri}`);
  console.log(`  │  Enter code: ${data.user_code}`);
  console.log(`  └──────────────────────────────────────────┘\n`);

  // 3. Poll until approved or expired
  const pollInterval = (data.interval || 5) * 1000;
  const deadline = Date.now() + data.expires_in * 1000;

  while (Date.now() < deadline) {
    await Bun.sleep(pollInterval);

    try {
      const pollRes = await fetch(`${cloudUrl}/auth/device-code/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: data.device_code }),
      });

      if (!pollRes.ok) {
        if (pollRes.status === 410) throw new Error("Code expired. Try again.");
        continue;
      }

      const result = await pollRes.json() as {
        status: string;
        access_token?: string;
        email?: string;
      };

      if (result.status === "approved" && result.access_token && result.email) {
        const auth: CloudAuth = {
          access_token: result.access_token,
          refresh_token: "",
          email: result.email,
          cloud_url: cloudUrl,
          saved_at: new Date().toISOString(),
        };
        saveCloudAuth(auth);
        return auth;
      }

      // Still pending — show dots
      process.stdout.write(".");
    } catch (err) {
      if (err instanceof Error && err.message.includes("expired")) throw err;
      // Network error — keep polling
    }
  }

  throw new Error("Login timed out. Try again.");
}

// ─── Device Registration ────────────────────────────────────────────────

/** Register or re-register this machine with cloud */
export async function linkDevice(name?: string): Promise<CloudDevice> {
  const auth = getCloudAuth();
  if (!auth) throw new Error("Not logged in. Run 'ppm cloud login' first.");

  const machineId = getMachineId();
  const deviceName = name || (configService.get("device_name") as string) || hostname() || "Unknown Machine";

  const res = await cloudFetch("/api/devices", {
    method: "POST",
    body: JSON.stringify({
      machine_id: machineId,
      name: deviceName,
      version: VERSION,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to register device: ${err}`);
  }

  const data = await res.json() as { id: string; secret_key: string };

  const device: CloudDevice = {
    device_id: data.id,
    secret_key: data.secret_key,
    name: deviceName,
    machine_id: machineId,
    cloud_url: auth.cloud_url,
    linked_at: new Date().toISOString(),
  };

  saveCloudDevice(device);
  return device;
}

/** Unlink this machine from cloud */
export async function unlinkDevice(): Promise<void> {
  const device = getCloudDevice();
  if (!device) {
    removeCloudDevice();
    return;
  }

  try {
    await cloudFetch(`/api/devices/${device.device_id}`, { method: "DELETE" });
  } catch {
    // Continue even if cloud unreachable — clean up local state
  }
  removeCloudDevice();
}

/** List all devices for the logged-in user */
export async function listDevices(): Promise<DeviceInfo[]> {
  const res = await cloudFetch("/api/devices");
  if (!res.ok) throw new Error(`Failed to list devices: ${res.status}`);
  const data = await res.json() as { devices: DeviceInfo[] };
  return data.devices;
}

// ─── Heartbeat ──────────────────────────────────────────────────────────

/** Send a single heartbeat to cloud (non-blocking, logs errors) */
export async function sendHeartbeat(tunnelUrl: string): Promise<boolean> {
  const device = getCloudDevice();
  if (!device) return false;

  try {
    const res = await fetch(`${device.cloud_url}/api/devices/${device.device_id}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret_key: device.secret_key,
        tunnel_url: tunnelUrl,
        status: "online",
        name: device.name,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Survive Bun --hot reloads: persist timer ref across module re-evaluations
const CLOUD_HOT_KEY = "__PPM_CLOUD_HEARTBEAT__" as const;
const cloudHotState = ((globalThis as any)[CLOUD_HOT_KEY] ??= {
  heartbeatTimer: null as ReturnType<typeof setInterval> | null,
}) as { heartbeatTimer: ReturnType<typeof setInterval> | null };

/** Start periodic heartbeat (call once after tunnel URL is obtained) */
export function startHeartbeat(tunnelUrl: string): void {
  // Clear any existing heartbeat to prevent duplicates on restart
  if (cloudHotState.heartbeatTimer) clearInterval(cloudHotState.heartbeatTimer);

  // Initial heartbeat immediately
  sendHeartbeat(tunnelUrl).then((ok) => {
    if (ok) console.log("  ➜  Cloud:   synced to PPM Cloud");
    else console.warn("  ⚠  Cloud sync failed (non-blocking)");
  });

  // Periodic heartbeat every 5 minutes
  cloudHotState.heartbeatTimer = setInterval(() => {
    sendHeartbeat(tunnelUrl).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);
}

/** Stop periodic heartbeat */
export function stopHeartbeat(): void {
  if (cloudHotState.heartbeatTimer) {
    clearInterval(cloudHotState.heartbeatTimer);
    cloudHotState.heartbeatTimer = null;
  }
}

// ─── Alias Management ───────────────────────────────────────────────────

/** Set or update device alias slug. Uses secret_key auth (no JWT needed). */
export async function setAlias(slug: string): Promise<{ slug: string }> {
  const device = getCloudDevice();
  if (!device) throw new Error("Not linked to PPM Cloud. Run: ppm cloud link");

  const res = await fetch(`${device.cloud_url}/api/devices/${device.device_id}/slug`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug, secret_key: device.secret_key }),
  });

  const data = await res.json() as { slug?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return { slug: data.slug! };
}

/** Remove device alias slug. Uses secret_key auth (no JWT needed). */
export async function removeAlias(): Promise<void> {
  const device = getCloudDevice();
  if (!device) throw new Error("Not linked to PPM Cloud. Run: ppm cloud link");

  const res = await fetch(`${device.cloud_url}/api/devices/${device.device_id}/slug`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug: null, secret_key: device.secret_key }),
  });

  if (!res.ok) {
    const data = await res.json() as { error?: string };
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
}

/** Get current device alias slug. Uses JWT auth. */
export async function getAlias(): Promise<{ slug: string | null }> {
  const device = getCloudDevice();
  if (!device) throw new Error("Not linked to PPM Cloud. Run: ppm cloud link");

  const auth = getCloudAuth();
  if (!auth) throw new Error("Not logged in. Run: ppm cloud login");

  const res = await fetch(`${device.cloud_url}/api/devices/${device.device_id}/slug`, {
    headers: { Authorization: `Bearer ${auth.access_token}` },
  });

  if (!res.ok) {
    if (res.status === 401) throw new Error("Session expired. Run: ppm cloud login");
    throw new Error(`HTTP ${res.status}`);
  }
  const data = await res.json() as { slug?: string | null };
  return { slug: data.slug ?? null };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function ensurePpmDir(): void {
  const dir = getPpmDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function openBrowser(url: string): void {
  try {
    if (process.platform === "darwin") {
      Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
    } else if (process.platform === "win32") {
      Bun.spawn(["cmd", "/c", "start", url], { stdout: "ignore", stderr: "ignore" });
    } else {
      Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
    }
  } catch {}
}

function successHtml(email: string): string {
  const safe = email.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!DOCTYPE html><html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#fff">
<div style="text-align:center"><h1>✓ Logged in</h1><p>Logged in as <b>${safe}</b></p><p style="color:#888">You can close this tab and return to the terminal.</p></div></body></html>`;
}

function errorHtml(message: string): string {
  return `<!DOCTYPE html><html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#fff">
<div style="text-align:center"><h1>✗ Login Failed</h1><p>${message}</p></div></body></html>`;
}

export { DEFAULT_CLOUD_URL, HEARTBEAT_INTERVAL_MS };
