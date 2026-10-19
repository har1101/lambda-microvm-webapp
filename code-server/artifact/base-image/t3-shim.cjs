// t3poc in-VM shim on :8080 (the MicroVM endpoint port) -> t3 serve on 127.0.0.1:3773.
// The AWS endpoint needs Host=<endpoint>, but T3 checks DPoP `htu` and browser
// Origin against the Host the client used (http://127.0.0.1:<port> via the Mac
// relay). The relay sends that address in X-T3poc-Host; restore it as Host.
const http = require('node:http');
const net = require('node:net');

const T3 = { host: '127.0.0.1', port: Number(process.env.T3_INTERNAL_PORT ?? 3773) };
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;
const DROP = new Set(['x-t3poc-host', 'x-aws-proxy-auth', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-for']);

function rewriteHeaders(rawHeaders) {
  const out = [];
  let clientHost;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const key = rawHeaders[i].toLowerCase();
    if (key === 'x-t3poc-host' && LOOPBACK_HOST.test(rawHeaders[i + 1])) clientHost = rawHeaders[i + 1];
  }
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const key = rawHeaders[i].toLowerCase();
    if (DROP.has(key)) continue;
    if (key === 'host' && clientHost) continue;
    out.push([rawHeaders[i], rawHeaders[i + 1]]);
  }
  if (clientHost) out.unshift(['Host', clientHost]);
  return out;
}

function forward(req, res) {
  const headers = {};
  for (const [k, v] of rewriteHeaders(req.rawHeaders)) {
    const key = k.toLowerCase();
    headers[key] = key in headers ? [].concat(headers[key], v) : v;
  }
  const up = http.request({ ...T3, path: req.url, method: req.method, headers }, (u) => {
    res.writeHead(u.statusCode, u.headers);
    u.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(up);
}

function upgrade(req, socket, head) {
  const up = net.connect(T3.port, T3.host, () => {
    const lines = [
      `${req.method} ${req.url} HTTP/1.1`,
      ...rewriteHeaders(req.rawHeaders).map(([k, v]) => `${k}: ${v}`),
    ];
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
}

module.exports = { rewriteHeaders };

if (require.main === module) {
  const server = http.createServer(forward);
  server.on('upgrade', upgrade);
  server.listen(Number(process.env.SHIM_PORT ?? 8080), process.env.SHIM_HOST ?? '0.0.0.0');
}
