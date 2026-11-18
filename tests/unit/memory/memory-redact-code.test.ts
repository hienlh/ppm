import { describe, expect, test } from "bun:test";
import { redactSecrets } from "../../../src/services/memory/memory-redact.ts";

// Found by syncing the real Claude memories of this project (2026-11-12): code and lists of key
// names were blanked as if they were credentials.
describe("redactSecrets leaves code and key-name lists alone", () => {
  test("an assignment whose value is a call expression", () => {
    const text = "`describe.skipIf(!engine.url)(name, () => { const secret = parts(engine.url!).password; … })`";
    expect(redactSecrets(text)).toEqual({ text, count: 0 });
  });

  test("a list of key names after password=", () => {
    const text = "read their target from `ppm.properties` (server=/password=/project=; write it with umask 077)";
    expect(redactSecrets(text)).toEqual({ text, count: 0 });
  });

  test("a real-looking value is still blanked, base64 padding included", () => {
    const { text, count } = redactSecrets("TOKEN=Zm9vYmFyYmF6cXV4MTIz==\nnext line");
    expect(count).toBe(1);
    expect(text).toBe("TOKEN=[REDACTED]\nnext line");
  });
});
