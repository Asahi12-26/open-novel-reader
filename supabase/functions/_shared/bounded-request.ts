/** Enforce the limit while reading, before buffering/parsing an untrusted authenticated request. */
export async function readBoundedJSON(request: Request, maxBytes: number): Promise<unknown> {
  const advertised = Number(request.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > maxBytes) throw new Error('REQUEST_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('INVALID_JSON');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new Error('REQUEST_TOO_LARGE'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('INVALID_JSON'); }
}
