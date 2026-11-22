/**
 * The signed assertion a Google service account trades for an access token (RFC 7523): an RS256
 * JWT over the account's `private_key`, signed with WebCrypto so PPM needs no Google library.
 */

export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
/** The assertion's audience: Google's token endpoint, whatever address a test posts it to. */
export const GOOGLE_TOKEN_AUDIENCE = "https://oauth2.googleapis.com/token";
const LIFETIME_SECONDS = 3600;

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

const encodeJson = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));

/** The DER bytes inside a PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`), the form Google issues. */
function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const match = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(pem.replace(/\\n/g, "\n"));
  if (!match) throw new Error("Not a PKCS#8 private key");
  const der = Buffer.from(match[1]!.replace(/\s+/g, ""), "base64");
  if (der.length === 0) throw new Error("Empty private key");
  return new Uint8Array(der);
}

export function importServiceAccountKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export interface ServiceAccountAssertionInput {
  clientEmail: string;
  privateKey: string;
  privateKeyId?: string;
  /** Seconds since the epoch; a test seam. */
  now?: number;
}

/** `header.claims.signature`, valid for an hour from `now`. */
export async function signServiceAccountAssertion(input: ServiceAccountAssertionInput): Promise<string> {
  const iat = input.now ?? Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", ...(input.privateKeyId ? { kid: input.privateKeyId } : {}) };
  const claims = { iss: input.clientEmail, scope: FCM_SCOPE, aud: GOOGLE_TOKEN_AUDIENCE, iat, exp: iat + LIFETIME_SECONDS };
  const signingInput = `${encodeJson(header)}.${encodeJson(claims)}`;
  const key = await importServiceAccountKey(input.privateKey);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}
