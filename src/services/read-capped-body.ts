/**
 * A request body as text, or null when it is over `maxBytes`. Counted in bytes as it arrives,
 * so a body sent without a `Content-Length` (chunked) is refused without being read to its
 * end, and a lying `Content-Length` cannot get a larger body through.
 */
export async function readCappedBody(req: Request, maxBytes: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
