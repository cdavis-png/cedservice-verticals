/* ============================================================
   CED Intelligence Platform — bounded request body reader
   ------------------------------------------------------------
   Content-Length is a claim, not a fact. A chunked request need
   not send one, and a hostile client can send one that lies.
   Reading the whole body and checking its size afterwards means
   the attacker chooses how much memory the function allocates.

   This reader counts bytes as the stream is consumed and stops
   at the first chunk that crosses the limit. Nothing beyond the
   limit is retained, and oversized bodies are never handed to
   JSON.parse.

   Decoding is strict: malformed UTF-8 is a rejection, not a
   replacement character, because a payload that does not decode
   cleanly is not a payload we should be storing.

   Returns a result object rather than throwing, so the caller
   maps outcomes to status codes in one place.

   Classic script on purpose — see the note in engine.js.
   ============================================================ */

(() => {
  'use strict';

  const OUTCOME = {
    ok: 'ok',
    tooLarge: 'too_large',
    invalidEncoding: 'invalid_encoding',
    readFailed: 'read_failed'
  };

  const result = (outcome, extra = {}) => ({ outcome, ok: outcome === OUTCOME.ok, ...extra });

  /* A declared Content-Length over the limit is refused immediately: there is
     no reason to open the stream at all. A declared length under the limit is
     NOT trusted — the byte counter below is what actually enforces it. */
  const declaredLengthExceeds = (request, maxBytes) => {
    const header = request && request.headers && typeof request.headers.get === 'function'
      ? request.headers.get('content-length')
      : null;
    if (header === null || header === undefined || header === '') return false;
    const declared = Number(header);
    return Number.isFinite(declared) && declared > maxBytes;
  };

  /* Accepts anything shaped like a Request: a `body` that is a ReadableStream
     (or async-iterable) plus a `headers` with get(). Falls back to text() only
     when no stream is available, and still enforces the bound afterwards. */
  const readBoundedBody = async (request, maxBytes) => {
    if (!(Number.isFinite(maxBytes) && maxBytes > 0)) {
      throw new TypeError('readBoundedBody requires a positive maxBytes');
    }

    if (declaredLengthExceeds(request, maxBytes)) {
      return result(OUTCOME.tooLarge, { bytesRead: 0, declared: true });
    }

    const body = request ? request.body : null;
    const chunks = [];
    let bytesRead = 0;

    const take = chunk => {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      bytesRead += bytes.byteLength;
      if (bytesRead > maxBytes) return false;   /* stop; the chunk is discarded */
      chunks.push(bytes);
      return true;
    };

    try {
      if (body && typeof body.getReader === 'function') {
        const reader = body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && !take(value)) {
              /* Release the connection without draining the rest. */
              try { await reader.cancel(); } catch { /* already gone */ }
              return result(OUTCOME.tooLarge, { bytesRead, declared: false });
            }
          }
        } finally {
          try { reader.releaseLock(); } catch { /* stream already closed */ }
        }
      } else if (body && typeof body[Symbol.asyncIterator] === 'function') {
        for await (const value of body) {
          if (!take(value)) return result(OUTCOME.tooLarge, { bytesRead, declared: false });
        }
      } else if (request && typeof request.text === 'function') {
        /* No stream to meter. The platform has already buffered this, so the
           only thing left to do is refuse it before parsing. */
        const text = await request.text();
        const size = byteLength(text);
        if (size > maxBytes) return result(OUTCOME.tooLarge, { bytesRead: size, declared: false });
        return result(OUTCOME.ok, { text, bytesRead: size });
      } else {
        return result(OUTCOME.ok, { text: '', bytesRead: 0 });
      }
    } catch (err) {
      return result(OUTCOME.readFailed, { bytesRead, cause: err && err.name });
    }

    let text;
    try {
      text = decodeStrict(chunks, bytesRead);
    } catch {
      return result(OUTCOME.invalidEncoding, { bytesRead });
    }
    return result(OUTCOME.ok, { text, bytesRead });
  };

  const decodeStrict = (chunks, total) => {
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    /* fatal: true turns malformed UTF-8 into a throw instead of U+FFFD. */
    return new TextDecoder('utf-8', { fatal: true }).decode(merged);
  };

  const byteLength = text => {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).byteLength;
    return Buffer.byteLength(text, 'utf8');
  };

  /* Parsing lives here so an oversized body can never reach it by accident. */
  const parseJsonSafely = text => {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: false, value: null };
    }
  };

  const API = { OUTCOME, readBoundedBody, parseJsonSafely, byteLength };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDReadBody = API;
})();
