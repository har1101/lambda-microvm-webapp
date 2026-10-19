import { Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

const STYLE_PATH = '/.t3poc/auth-layout.css';
// T3's standalone auth card can exceed the viewport while body and #root
// inherit the chat shell's overflow:hidden. Release those ancestors only
// while that card is mounted; SPA navigation back to chat keeps its layout.
export const AUTH_LAYOUT_CSS = `html:has(#root > .min-h-screen > section),
html:has(#root > .min-h-screen > section) body,
#root:has(> .min-h-screen > section) {
  height: auto !important;
  min-height: 100%;
  overflow: visible !important;
}
`;
const DOCUMENTS = new Set(['/', '/connect-agent', '/pair', '/connect']);
const HASHED_ASSET = /^\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/;
const MAX_HTML_BYTES = 256 * 1024;

export function isWebDocument(req) {
  return req.method === 'GET' && DOCUMENTS.has(req.url.split('?')[0]);
}

export function webRequestHeaders(req, headers) {
  if (!isWebDocument(req)) return headers;
  const out = { ...headers, 'accept-encoding': 'identity' };
  // A 304 could reuse an unpatched document from before the relay update.
  delete out['if-none-match'];
  delete out['if-modified-since'];
  return out;
}

export function serveWebStyle(req, res) {
  if (req.url !== STYLE_PATH) return false;
  res.writeHead(req.method === 'GET' || req.method === 'HEAD' ? 200 : 405, {
    'content-type': 'text/css; charset=utf-8',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  res.end(req.method === 'GET' ? AUTH_LAYOUT_CSS : undefined);
  return true;
}

export function forwardWebResponse(req, res, upstream) {
  const headers = { ...upstream.headers };
  if (
    upstream.statusCode === 200 &&
    req.method === 'GET' &&
    HASHED_ASSET.test(req.url) &&
    /^(?:text\/(?:javascript|css)|application\/javascript)(?:;|$)/i.test(headers['content-type'] ?? '') &&
    !headers['set-cookie'] &&
    !/private|no-store/i.test(headers['cache-control'] ?? '')
  ) {
    // Content-hashed public build assets do not need a remote revalidation
    // for every import on every navigation. Never cache API/auth responses.
    headers['cache-control'] = 'public, max-age=31536000, immutable';
  }
  const encoding = String(headers['content-encoding'] ?? 'identity').toLowerCase();
  const decoders = { gzip: createGunzip, br: createBrotliDecompress, deflate: createInflate };
  if (
    !isWebDocument(req) ||
    upstream.statusCode !== 200 ||
    !/^text\/html(?:;|$)/i.test(headers['content-type'] ?? '') ||
    (encoding !== 'identity' && !decoders[encoding])
  ) {
    res.writeHead(upstream.statusCode, headers);
    upstream.pipe(res);
    return;
  }
  for (const key of ['content-length', 'content-encoding', 'etag', 'content-md5', 'digest']) delete headers[key];
  headers['cache-control'] = 'no-store';
  res.writeHead(upstream.statusCode, headers);
  let chunks = [];
  let size = 0;
  let passthrough = false;
  const html = new Transform({
    transform(chunk, _encoding, callback) {
      if (passthrough) return callback(null, chunk);
      chunks.push(chunk);
      size += chunk.length;
      if (size > MAX_HTML_BYTES) {
        passthrough = true;
        for (const buffered of chunks) this.push(buffered);
        chunks = [];
      }
      callback();
    },
    flush(callback) {
      if (!passthrough) {
        const text = Buffer.concat(chunks).toString('utf8');
        this.push(text.replace(/<\/head>/i, `<link rel="stylesheet" href="${STYLE_PATH}"></head>`));
      }
      callback();
    },
  });
  html.on('error', () => res.destroy());
  // Downstream disconnects still tear down the upstream in createRelay.
  res.once('close', () => html.destroy());
  if (encoding !== 'identity') {
    const decoder = decoders[encoding]();
    decoder.on('error', () => res.destroy());
    res.once('close', () => decoder.destroy());
    upstream.pipe(decoder).pipe(html).pipe(res);
  } else upstream.pipe(html).pipe(res);
}
