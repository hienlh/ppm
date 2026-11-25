import { describe, expect, it } from "bun:test";
import { FCM_SCOPE, GOOGLE_TOKEN_AUDIENCE, signServiceAccountAssertion } from "../../../src/services/fcm/fcm-jwt.ts";
import { makeServiceAccount } from "../../helpers/fcm-fixtures.ts";

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

describe("signServiceAccountAssertion", () => {
  it("makes an RS256 JWT the account's public key verifies, with Google's claims", async () => {
    const sa = await makeServiceAccount();
    const jwt = await signServiceAccountAssertion({
      clientEmail: sa.json.client_email as string,
      privateKey: sa.json.private_key as string,
      privateKeyId: sa.json.private_key_id as string,
      now: 1_800_000_000,
    });
    const [header, claims, signature] = jwt.split(".");
    expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT", kid: sa.json.private_key_id });
    expect(decode(claims!)).toEqual({
      iss: sa.json.client_email,
      scope: FCM_SCOPE,
      aud: GOOGLE_TOKEN_AUDIENCE,
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      sa.publicKey,
      Buffer.from(signature!, "base64url"),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);

    // Another key's signature does not verify: the check above is not vacuous.
    const other = await makeServiceAccount();
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", other.publicKey, Buffer.from(signature!, "base64url"), new TextEncoder().encode(`${header}.${claims}`))).toBe(false);
  });

  it("reads a key whose newlines were pasted as \\n", async () => {
    const sa = await makeServiceAccount();
    const escaped = (sa.json.private_key as string).replace(/\n/g, "\\n");
    const jwt = await signServiceAccountAssertion({ clientEmail: "a@b", privateKey: escaped });
    expect(jwt.split(".")).toHaveLength(3);
  });

  it("refuses something that is not a PKCS#8 key", async () => {
    await expect(signServiceAccountAssertion({ clientEmail: "a@b", privateKey: "nope" })).rejects.toThrow();
  });
});
