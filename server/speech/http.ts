/**
 * Bounded HTTP body reading for speech providers. Upstreams are configured by the operator but may
 * be misconfigured or hostile, so no response is ever read with an unbounded `res.text()`.
 */
export class ResponseTooLargeError extends Error {
  constructor(readonly limit: number) { super(`response exceeds ${limit} bytes`); this.name = "ResponseTooLargeError"; }
}

/**
 * Stream the body and cancel the connection as soon as `maxBytes` is exceeded.
 * - default: throw `ResponseTooLargeError` (for bodies that must be complete, e.g. audio, JSON).
 * - `truncate: true`: stop reading and return what fits (for diagnostic snippets of error bodies).
 */
export async function readBodyLimited(res: Response, maxBytes: number, options: { truncate?: boolean } = {}): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (!options.truncate && res.headers.has("content-length") && Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError(maxBytes);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - size;
      if (value.byteLength > remaining) {
        await reader.cancel().catch(() => {});
        if (!options.truncate) throw new ResponseTooLargeError(maxBytes);
        if (remaining > 0) chunks.push(Buffer.from(value.subarray(0, remaining)));
        break;
      }
      size += value.byteLength;
      chunks.push(Buffer.from(value));
      if (options.truncate && size >= maxBytes) { await reader.cancel().catch(() => {}); break; }
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks);
}

/** Cap for diagnostic snippets of non-2xx / non-audio bodies. */
export const ERROR_BODY_SNIPPET_BYTES = 4096;
