import { describe, expect, it } from 'vitest';
import { readBoundedJSON } from '../../supabase/functions/_shared/bounded-request';

describe('AI proxy streaming body limits', () => {
  it('parses an allowed UTF-8 JSON object', async () => {
    const request = new Request('https://example.invalid', { method: 'POST', body: JSON.stringify({ text: '中文对白' }) });
    expect(await readBoundedJSON(request, 100)).toEqual({ text: '中文对白' });
  });
  it('rejects an oversized chunked request before consuming its remaining chunks', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(100)); },
      cancel() { cancelled = true; },
    });
    const request = { body: stream, headers: new Headers() } as Request;
    await expect(readBoundedJSON(request, 64)).rejects.toThrow('REQUEST_TOO_LARGE');
    expect(cancelled).toBe(true);
  });
  it('rejects malformed JSON and a declared oversized body', async () => {
    await expect(readBoundedJSON(new Request('https://example.invalid', { method: 'POST', body: '{' }), 100)).rejects.toThrow('INVALID_JSON');
    const request = { headers: new Headers({ 'content-length': '1000' }), body: null } as Request;
    await expect(readBoundedJSON(request, 64)).rejects.toThrow('REQUEST_TOO_LARGE');
  });
});
