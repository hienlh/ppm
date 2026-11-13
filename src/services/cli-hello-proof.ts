import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The identity proof a server gives the `ppm` CLI before the CLI sends it the token.
 *
 * The CLI picks a server from an endpoint file, which anything on the machine could have written,
 * and a port, which anything could be listening on. Sending `Authorization` there first would hand
 * the token to whoever answered. So the CLI sends a fresh nonce to the public `/api/cli/hello`,
 * and only a process that holds the same token can answer with this HMAC of it. The token itself
 * never crosses the wire until the answer checks out.
 *
 * The HMAC covers the port the server serves the CLI on, which the CLI then sends the token to: a
 * process that relays the nonce to the real server from a port of its own gets back a proof for
 * the real port, which does not match the one it advertised.
 */
export const HELLO_NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function helloProof(token: string, nonce: string, instanceId: string, port: number): string {
  return createHmac("sha256", token).update(`${nonce}|${instanceId}|${port}`).digest("hex");
}

export function helloProofMatches(token: string, nonce: string, instanceId: string, port: number, proof: unknown): boolean {
  if (typeof proof !== "string" || !/^[0-9a-f]{64}$/.test(proof)) return false;
  const expected = Buffer.from(helloProof(token, nonce, instanceId, port), "hex");
  return timingSafeEqual(expected, Buffer.from(proof, "hex"));
}

export function newHelloNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
}
