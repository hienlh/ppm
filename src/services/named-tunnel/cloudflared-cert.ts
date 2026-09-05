/**
 * Parse `~/.cloudflared/cert.pem` — the credential `cloudflared tunnel login` writes.
 * State is always derived by parsing the file, never `existsSync`: a truncated,
 * foreign, or revoked cert must never look "authenticated" just because a file
 * happens to sit at the expected path.
 */
import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

export interface ArgoCert {
  zoneID: string;
  accountID: string;
  apiToken: string;
}

export type CertState =
  | { kind: "absent" }
  | { kind: "unparseable"; reason: string }
  | { kind: "parsed"; cert: ArgoCert };

const HEX32 = /^[0-9a-f]{32}$/;
// The real-world label cloudflared ships today.
const STRICT_BLOCK = /-----BEGIN ARGO TUNNEL TOKEN-----([\s\S]*?)-----END ARGO TUNNEL TOKEN-----/;
// Fallback for a future cloudflared build that renames the label — accept any
// "...TOKEN..." PEM block rather than hard-failing every login on a cosmetic
// rename, while still preferring the known-good label as the first match.
const GENERIC_TOKEN_BLOCK = /-----BEGIN ([A-Z0-9 ]*TOKEN[A-Z0-9 ]*)-----([\s\S]*?)-----END \1-----/;

/**
 * `cloudflared` decides this location, not PPM — it is a deliberate real-`homedir()`
 * exception (see CLAUDE.md's "PPM Directory" section): `getPpmDir()` would point
 * PPM's own data elsewhere and never find the user's actual login credential.
 */
export function getOriginCertPath(): string {
  return process.env.TUNNEL_ORIGIN_CERT || resolve(homedir(), ".cloudflared", "cert.pem");
}

/** Extract the token PEM block's base64 payload, trying the strict label first. */
function extractPayload(pem: string): string | null {
  const strict = pem.match(STRICT_BLOCK);
  if (strict) return strict[1]!;
  const generic = pem.match(GENERIC_TOKEN_BLOCK);
  if (generic) return generic[2]!;
  return null;
}

/**
 * Read and parse the origin cert. Never throws — every failure mode collapses
 * to `unparseable` with a reason string that is safe to log (it never contains
 * the base64 payload or any field value, so a leaked apiToken can't hide in it).
 */
export function readOriginCertState(path?: string): CertState {
  const certPath = path ?? getOriginCertPath();
  if (!existsSync(certPath)) return { kind: "absent" };

  let raw: string;
  try {
    raw = readFileSync(certPath, "utf-8");
  } catch {
    return { kind: "unparseable", reason: "cert.pem could not be read" };
  }

  const payload = extractPayload(raw);
  if (payload == null) return { kind: "unparseable", reason: "no TOKEN PEM block found" };

  let decoded: string;
  try {
    decoded = Buffer.from(payload.replace(/\s+/g, ""), "base64").toString("utf-8");
  } catch {
    return { kind: "unparseable", reason: "PEM block is not valid base64" };
  }

  let json: unknown;
  try {
    json = JSON.parse(decoded);
  } catch {
    return { kind: "unparseable", reason: "PEM payload is not valid JSON" };
  }

  if (typeof json !== "object" || json === null) {
    return { kind: "unparseable", reason: "PEM payload is not a JSON object" };
  }
  const obj = json as Record<string, unknown>;
  const { zoneID, accountID, apiToken } = obj;
  if (typeof zoneID !== "string" || !zoneID || typeof accountID !== "string" || !accountID ||
      typeof apiToken !== "string" || !apiToken) {
    return { kind: "unparseable", reason: "cert is missing zoneID/accountID/apiToken" };
  }
  if (!HEX32.test(zoneID) || !HEX32.test(accountID)) {
    return { kind: "unparseable", reason: "zoneID/accountID are not 32-char hex ids" };
  }

  return { kind: "parsed", cert: { zoneID, accountID, apiToken } };
}
