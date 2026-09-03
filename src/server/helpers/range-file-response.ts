/**
 * Serve a local file with HTTP Range support (RFC 9110 §14).
 *
 * `<video>`/`<audio>` and pdf.js fetch media in byte ranges: the browser asks for
 * `Range: bytes=N-` when the user seeks and expects `206 Partial Content` back.
 * Without `Accept-Ranges` + `Content-Length` on the 200 response the browser cannot
 * even show the duration, so a `file.stream()` body (chunked, no length) breaks seeking.
 *
 * Bun ≥ 1.3.13 handles Range itself when the body is a `BunFile`, but PPM runs on
 * whatever Bun the user has installed, so the parsing is done here and works on
 * every version. Multi-range requests (`bytes=0-1,5-9`) fall back to the whole file,
 * which the spec allows.
 */

export interface ByteRange {
  start: number;
  /** Inclusive last byte. */
  end: number;
}

/**
 * Parse a single-range `Range` header against a resource of `size` bytes.
 * Returns `null` when there is no usable range (absent header, malformed, multi-range)
 * — caller should answer 200 with the whole file. Returns `"unsatisfiable"` when the
 * range lies entirely outside the file — caller should answer 416.
 */
export function parseRangeHeader(header: string | null | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;
  if (size <= 0) return "unsatisfiable";

  // Suffix range `bytes=-500` → last 500 bytes.
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return "unsatisfiable";
  // Open-ended `bytes=1024-` or an end past EOF are both clamped to the last byte.
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return "unsatisfiable";
  return { start, end };
}

/**
 * Build the `Response` for `absPath`, honouring the request's `Range` header.
 * `extraHeaders` are merged onto every response (Content-Disposition, Cache-Control…).
 * `contentType` overrides the sniffed MIME type (used for forced downloads).
 */
export function rangeFileResponse(
  absPath: string,
  req: Request,
  extraHeaders: Record<string, string> = {},
  contentType?: string,
): Response {
  const file = Bun.file(absPath);
  const size = file.size;
  const base: Record<string, string> = {
    "Accept-Ranges": "bytes",
    "Content-Type": contentType ?? (file.type || "application/octet-stream"),
    ...extraHeaders,
  };

  const range = parseRangeHeader(req.headers.get("range"), size);
  if (range === null) {
    // Whole file. Bun derives Content-Length from the BunFile body.
    return new Response(file, { status: 200, headers: { ...base, "Content-Length": String(size) } });
  }
  if (range === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${size}` } });
  }
  const { start, end } = range;
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: {
      ...base,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
    },
  });
}
